const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Block = require('../models/Block');
const redisService = require('./redis');

// Self-contained cookie parser for socket handshake headers
const parseCookieString = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, str) => {
    const idx = str.indexOf('=');
    if (idx !== -1) {
      const key = str.slice(0, idx).trim();
      const val = str.slice(idx + 1).trim();
      try {
        acc[key] = decodeURIComponent(val);
      } catch (e) {
        acc[key] = val;
      }
    }
    return acc;
  }, {});
};

let io = null;
// In-memory tracker: userId -> Set of socketIds
const onlineUsers = new Map();

/**
 * Initialize Socket.IO server
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
    },
    pingTimeout: 5000,
    pingInterval: 10000
  });

  // Authentication middleware for Socket connections
  io.use(async (socket, next) => {
    try {
      let token = null;

      // 1. Handshake auth token
      if (socket.handshake.auth && socket.handshake.auth.token) {
        token = socket.handshake.auth.token;
      }
      // 2. Authorization header
      else if (socket.handshake.headers.authorization) {
        const authHeader = socket.handshake.headers.authorization;
        if (authHeader.startsWith('Bearer ')) {
          token = authHeader.split(' ')[1];
        }
      }
      // 3. Cookie (nexchat_token)
      else if (socket.handshake.headers.cookie) {
        const cookies = parseCookieString(socket.handshake.headers.cookie);
        token = cookies.nexchat_token;
      }

      if (!token) {
        return next(new Error('Authentication error: Token required'));
      }

      const secret = process.env.JWT_SECRET || 'nexchat_jwt_secret_change_in_production_2024';
      const decoded = jwt.verify(token, secret);

      const user = await User.findById(decoded.id).select('_id username name avatar role privacySettings');
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch (err) {
      return next(new Error(`Authentication error: ${err.message}`));
    }
  });

  // Handle connection
  io.on('connection', async (socket) => {
    const userId = socket.userId;
    console.log(`[Socket] User connected: ${userId} (Socket ID: ${socket.id})`);

    // Add to user's dedicated room
    socket.join(userId);

    // Track online user sockets
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    // Track in Redis if available
    await redisService.sadd(`online_user:${userId}`, socket.id);
    await redisService.sadd('all_online_users', userId);

    // Update user status in database
    const now = new Date();
    await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: now });

    // Send currently online user list to newly connected user
    socket.emit('users:online', Array.from(onlineUsers.keys()));

    // Broadcast presence update immediately to all clients
    io.emit('presence:updated', {
      userId,
      isOnline: true,
      lastSeen: now
    });

    // Deliver all pending messages sent to this user while they were offline
    try {
      const userConvs = await Conversation.find({ 'participants.user': userId }).select('_id');
      const convIds = userConvs.map((c) => c._id);
      if (convIds.length > 0) {
        const pendingMessages = await Message.find({
          conversation: { $in: convIds },
          sender: { $ne: userId },
          status: 'sent'
        });

        if (pendingMessages.length > 0) {
          const nowDeliver = new Date();
          await Message.updateMany(
            { _id: { $in: pendingMessages.map((m) => m._id) } },
            {
              $set: { status: 'delivered' },
              $addToSet: { deliveredTo: { user: userId, deliveredAt: nowDeliver } }
            }
          );

          const senderConvs = new Map();
          for (const m of pendingMessages) {
            const sId = m.sender.toString();
            if (!senderConvs.has(sId)) {
              senderConvs.set(sId, new Set());
            }
            senderConvs.get(sId).add(m.conversation.toString());
          }

          for (const [sId, cSet] of senderConvs) {
            for (const cId of cSet) {
              io.to(sId).emit('message:receipt', {
                conversationId: cId,
                userId,
                type: 'delivered',
                status: 'delivered',
                deliveredAt: nowDeliver
              });
            }
          }
        }
      }
    } catch (deliverErr) {
      console.error('[Socket] Pending message delivery error:', deliverErr);
    }

    // Event: join conversation room & mark messages as read
    socket.join(`user_${userId}`);
    socket.on('conversation:join', async (conversationId) => {
      if (!conversationId) return;
      socket.join(`conv_${conversationId}`);

      try {
        const nowRead = new Date();
        const unreadMsgs = await Message.find({
          conversation: conversationId,
          sender: { $ne: userId },
          status: { $ne: 'read' }
        });

        if (unreadMsgs.length > 0) {
          await Message.updateMany(
            { _id: { $in: unreadMsgs.map((m) => m._id) } },
            {
              $set: { status: 'read' },
              $addToSet: {
                readBy: { user: userId, readAt: nowRead },
                deliveredTo: { user: userId, deliveredAt: nowRead }
              }
            }
          );

          io.to(`conv_${conversationId}`).emit('message:receipt', {
            conversationId,
            userId,
            type: 'read',
            status: 'read',
            readAt: nowRead
          });

          // Also emit to all participants' personal rooms so sidebar ticks turn blue
          const conv = await Conversation.findById(conversationId).select('participants');
          if (conv && conv.participants) {
            conv.participants.forEach((p) => {
              const pId = p.user.toString();
              if (pId !== userId) {
                io.to(pId).emit('message:receipt', {
                  conversationId,
                  userId,
                  type: 'read',
                  status: 'read',
                  readAt: nowRead
                });
              }
            });
          }
        }
      } catch (readErr) {
        console.error('[Socket] conversation:join read marking error:', readErr);
      }
    });

    // Event: leave conversation room
    socket.on('conversation:leave', (conversationId) => {
      if (conversationId) {
        socket.leave(`conv_${conversationId}`);
      }
    });

    // Event: conversation read
    socket.on('conversation:read', async ({ conversationId }) => {
      if (!conversationId) return;
      try {
        const nowRead = new Date();
        await Message.updateMany(
          {
            conversation: conversationId,
            sender: { $ne: userId },
            status: { $ne: 'read' }
          },
          {
            $set: { status: 'read' },
            $addToSet: {
              readBy: { user: userId, readAt: nowRead },
              deliveredTo: { user: userId, deliveredAt: nowRead }
            }
          }
        );

        io.to(`conv_${conversationId}`).emit('message:receipt', {
          conversationId,
          userId,
          type: 'read',
          status: 'read',
          readAt: nowRead
        });

        // Also emit to all participants' personal rooms
        const conv = await Conversation.findById(conversationId).select('participants');
        if (conv && conv.participants) {
          conv.participants.forEach((p) => {
            const pId = p.user.toString();
            if (pId !== userId) {
              io.to(pId).emit('message:receipt', {
                conversationId,
                userId,
                type: 'read',
                status: 'read',
                readAt: nowRead
              });
            }
          });
        }
      } catch (err) {
        console.error('[Socket] conversation:read error:', err);
      }
    });

    // Event: typing indicator
    socket.on('typing:start', ({ conversationId }) => {
      if (conversationId) {
        socket.to(`conv_${conversationId}`).emit('typing:start', {
          conversationId,
          userId,
          username: socket.user.username
        });
      }
    });

    socket.on('typing:stop', ({ conversationId }) => {
      if (conversationId) {
        socket.to(`conv_${conversationId}`).emit('typing:stop', {
          conversationId,
          userId,
          username: socket.user.username
        });
      }
    });

    // Event: send message
    socket.on('message:send', async (data, callback) => {
      try {
        const { conversationId, content, type = 'text', attachments = [], replyTo = null, clientMessageId } = data;

        if (!conversationId) {
          if (callback) callback({ success: false, message: 'conversationId is required' });
          return;
        }

        if (!content && (!attachments || attachments.length === 0)) {
          if (callback) callback({ success: false, message: 'Message content or attachments required' });
          return;
        }

        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          if (callback) callback({ success: false, message: 'Conversation not found' });
          return;
        }

        const isMember = conversation.participants.some(
          (p) => p.user.toString() === userId
        );
        if (!isMember) {
          if (callback) callback({ success: false, message: 'You are not a participant of this conversation' });
          return;
        }

        // For private conversations, verify block status
        if (conversation.type === 'private') {
          const otherParticipant = conversation.participants.find(
            (p) => p.user.toString() !== userId
          );
          if (otherParticipant) {
            const blocked = await Block.findOne({
              $or: [
                { blocker: userId, blocked: otherParticipant.user },
                { blocker: otherParticipant.user, blocked: userId }
              ]
            });
            if (blocked) {
              if (callback) callback({ success: false, message: 'Cannot send message due to block settings' });
              return;
            }
          }
        }

        if (clientMessageId) {
          const existing = await Message.findOne({ clientMessageId });
          if (existing) {
            if (callback) callback({ success: true, message: existing });
            return;
          }
        }

        const normalizedAttachments = Array.isArray(attachments)
          ? attachments.map((att) => ({
              filename: att.filename || att.originalName || att.name || 'file',
              originalName: att.originalName || att.name || att.filename || 'file',
              mimetype: att.mimetype || att.type || 'application/octet-stream',
              size: typeof att.size === 'number' ? att.size : 0,
              url: att.url || '',
            }))
          : [];

        // Determine initial status based on recipient presence
        let initialStatus = 'sent';
        const nowMsg = new Date();
        const deliveredToList = [{ user: userId, deliveredAt: nowMsg }];
        const readByList = [];

        if (conversation.type === 'private') {
          const otherParticipant = conversation.participants.find(
            (p) => p.user.toString() !== userId
          );
          if (otherParticipant) {
            const otherUserId = otherParticipant.user.toString();
            if (isUserOnline(otherUserId)) {
              initialStatus = 'delivered';
              deliveredToList.push({ user: otherParticipant.user, deliveredAt: nowMsg });

              const room = io.sockets.adapter.rooms.get(`conv_${conversationId}`);
              const otherUserRoom = io.sockets.adapter.rooms.get(otherUserId);
              if (room && otherUserRoom) {
                for (const sockId of otherUserRoom) {
                  if (room.has(sockId)) {
                    initialStatus = 'read';
                    readByList.push({ user: otherParticipant.user, readAt: nowMsg });
                    break;
                  }
                }
              }
            }
          }
        }

        // Create new message
        const message = await Message.create({
          conversation: conversationId,
          sender: userId,
          content: content || '',
          type,
          attachments: normalizedAttachments,
          replyTo: replyTo || null,
          clientMessageId: clientMessageId || undefined,
          status: initialStatus,
          deliveredTo: deliveredToList,
          readBy: readByList
        });

        // Update conversation lastMessage
        const lastMessageSnippet = type === 'text' ? content : `[${type}]`;
        conversation.lastMessage = {
          content: lastMessageSnippet,
          sender: userId,
          timestamp: new Date(),
          type
        };
        await conversation.save();

        const populatedMessage = await Message.findById(message._id)
          .populate('sender', 'name username avatar')
          .populate({
            path: 'replyTo',
            select: 'content sender type attachments',
            populate: { path: 'sender', select: 'name username' }
          });

        // Emit to conversation room
        io.to(`conv_${conversationId}`).emit('message:new', populatedMessage);

        // Also emit directly to participants' individual rooms for sidebar updates
        conversation.participants.forEach((p) => {
          const pId = p.user.toString();
          io.to(pId).emit('conversation:lastMessage', {
            conversationId,
            lastMessage: conversation.lastMessage,
            message: populatedMessage
          });
        });

        if (callback) {
          callback({ success: true, message: populatedMessage });
        }
      } catch (err) {
        console.error('[Socket] message:send error:', err);
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // Event: edit message
    socket.on('message:edit', async (data, callback) => {
      try {
        const { messageId, content } = data;
        if (!messageId || !content) {
          if (callback) callback({ success: false, message: 'messageId and content are required' });
          return;
        }

        const message = await Message.findById(messageId);
        if (!message) {
          if (callback) callback({ success: false, message: 'Message not found' });
          return;
        }

        if (message.sender.toString() !== userId) {
          if (callback) callback({ success: false, message: 'Only sender can edit message' });
          return;
        }

        if (message.isDeleted) {
          if (callback) callback({ success: false, message: 'Cannot edit deleted message' });
          return;
        }

        message.content = content;
        message.isEdited = true;
        await message.save();

        const populated = await Message.findById(message._id)
          .populate('sender', 'name username avatar')
          .populate({
            path: 'replyTo',
            select: 'content sender type attachments',
            populate: { path: 'sender', select: 'name username' }
          });

        io.to(`conv_${message.conversation}`).emit('message:edited', populated);

        if (callback) callback({ success: true, message: populated });
      } catch (err) {
        console.error('[Socket] message:edit error:', err);
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // Event: delete message
    socket.on('message:delete', async (data, callback) => {
      try {
        const { messageId } = data;
        if (!messageId) {
          if (callback) callback({ success: false, message: 'messageId is required' });
          return;
        }

        const message = await Message.findById(messageId);
        if (!message) {
          if (callback) callback({ success: false, message: 'Message not found' });
          return;
        }

        if (message.sender.toString() !== userId) {
          if (callback) callback({ success: false, message: 'Only sender can delete message' });
          return;
        }

        message.isDeleted = true;
        message.content = 'This message was deleted';
        message.attachments = [];
        await message.save();

        io.to(`conv_${message.conversation}`).emit('message:deleted', {
          messageId: message._id,
          conversationId: message.conversation
        });

        if (callback) callback({ success: true, messageId: message._id });
      } catch (err) {
        console.error('[Socket] message:delete error:', err);
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // Event: message delivered receipt
    socket.on('message:delivered', async (data) => {
      try {
        const { messageId, conversationId } = data;
        if (!messageId) return;

        const message = await Message.findById(messageId);
        if (!message) return;

        const alreadyDelivered = message.deliveredTo.some((d) => d.user.toString() === userId);
        if (!alreadyDelivered) {
          const now = new Date();
          message.deliveredTo.push({ user: userId, deliveredAt: now });
          if (message.status === 'sent') {
            message.status = 'delivered';
          }
          await message.save();

          io.to(message.sender.toString()).emit('message:receipt', {
            messageId,
            conversationId: conversationId || message.conversation,
            userId,
            type: 'delivered',
            status: 'delivered',
            deliveredAt: now
          });
        }
      } catch (err) {
        console.error('[Socket] message:delivered error:', err);
      }
    });

    // Event: message read receipt
    socket.on('message:read', async (data) => {
      try {
        const { messageId, conversationId } = data;
        if (!messageId) return;

        const message = await Message.findById(messageId);
        if (!message) return;

        const alreadyRead = message.readBy.some((r) => r.user.toString() === userId);
        if (!alreadyRead) {
          const now = new Date();
          message.readBy.push({ user: userId, readAt: now });
          message.status = 'read';

          const alreadyDelivered = message.deliveredTo.some((d) => d.user.toString() === userId);
          if (!alreadyDelivered) {
            message.deliveredTo.push({ user: userId, deliveredAt: now });
          }

          await message.save();

          io.to(message.sender.toString()).emit('message:receipt', {
            messageId,
            conversationId: conversationId || message.conversation,
            userId,
            type: 'read',
            status: 'read',
            readAt: now
          });
          io.to(`conv_${message.conversation}`).emit('message:receipt', {
            messageId,
            conversationId: conversationId || message.conversation,
            userId,
            type: 'read',
            status: 'read',
            readAt: now
          });
        }
      } catch (err) {
        console.error('[Socket] message:read error:', err);
      }
    });

    // ==========================================
    // WebRTC Voice Calling Signaling Events
    // ==========================================

    socket.on('call:start', async ({ conversationId, recipientId, offer, callType = 'audio' }) => {
      try {
        if (!recipientId || !offer) {
          socket.emit('call:error', { message: 'recipientId and offer are required' });
          return;
        }

        const targetId = recipientId.toString();

        if (!isUserOnline(targetId)) {
          socket.emit('call:unavailable', {
            recipientId: targetId,
            reason: 'offline'
          });
          return;
        }

        const callId = `call_${Date.now()}_${userId}`;
        socket.currentCall = { callId, peerId: targetId };

        io.to(targetId).emit('call:incoming', {
          callId,
          conversationId,
          caller: {
            _id: userId,
            name: socket.user.name,
            username: socket.user.username,
            avatar: socket.user.avatar
          },
          offer,
          callType
        });
      } catch (err) {
        console.error('[Socket] call:start error:', err);
        socket.emit('call:error', { message: err.message });
      }
    });

    socket.on('call:accept', ({ callId, callerId, answer }) => {
      if (!callerId || !answer) return;
      const targetId = callerId.toString();
      socket.currentCall = { callId, peerId: targetId };

      io.to(targetId).emit('call:accepted', {
        callId,
        acceptorId: userId,
        answer
      });
    });

    socket.on('call:reject', ({ callId, callerId, reason }) => {
      if (!callerId) return;
      const targetId = callerId.toString();
      socket.currentCall = null;

      io.to(targetId).emit('call:rejected', {
        callId,
        fromUserId: userId,
        reason: reason || 'declined'
      });
    });

    socket.on('call:ice-candidate', ({ targetUserId, candidate, callId }) => {
      if (!targetUserId || !candidate) return;
      const targetId = targetUserId.toString();

      io.to(targetId).emit('call:ice-candidate', {
        candidate,
        fromUserId: userId,
        callId
      });
    });

    socket.on('call:end', ({ targetUserId, callId }) => {
      socket.currentCall = null;
      if (targetUserId) {
        const targetId = targetUserId.toString();
        io.to(targetId).emit('call:ended', {
          callId,
          fromUserId: userId
        });
      }
    });

    // Immediate disconnect handler
    const handleUserOffline = async () => {
      console.log(`[Socket] User disconnected: ${userId} (Socket ID: ${socket.id})`);

      if (onlineUsers.has(userId)) {
        const userSockets = onlineUsers.get(userId);
        userSockets.delete(socket.id);

        await redisService.srem(`online_user:${userId}`, socket.id);

        let hasActiveSockets = false;
        for (const sId of userSockets) {
          const activeSock = io.sockets.sockets.get(sId);
          if (activeSock && activeSock.connected) {
            hasActiveSockets = true;
            break;
          } else {
            userSockets.delete(sId);
          }
        }

        if (!hasActiveSockets) {
          onlineUsers.delete(userId);
          await redisService.srem('all_online_users', userId);

          const lastSeenDate = new Date();
          await User.findByIdAndUpdate(userId, {
            isOnline: false,
            lastSeen: lastSeenDate
          });

          io.emit('presence:updated', {
            userId,
            isOnline: false,
            lastSeen: lastSeenDate
          });

          // Also clear any lingering typing indicators
          socket.broadcast.emit('typing:stop', {
            userId,
            username: socket.user?.username
          });

          // Notify call peer if user was in a call
          if (socket.currentCall && socket.currentCall.peerId) {
            io.to(socket.currentCall.peerId).emit('call:ended', {
              callId: socket.currentCall.callId,
              fromUserId: userId,
              reason: 'disconnected'
            });
            socket.currentCall = null;
          }
        }
      }
    };

    socket.on('user:offline', handleUserOffline);
    socket.on('disconnect', handleUserOffline);
  });

  return io;
};

const getIO = () => {
  return io;
};

const isUserOnline = (userId) => {
  if (!userId) return false;
  const sockets = onlineUsers.get(userId.toString());
  if (!sockets || sockets.size === 0) return false;
  if (!io) return sockets.size > 0;
  for (const sId of sockets) {
    const s = io.sockets.sockets.get(sId);
    if (s && s.connected) return true;
  }
  return false;
};

const getOnlineUserIds = () => {
  return Array.from(onlineUsers.keys());
};

module.exports = {
  initSocket,
  getIO,
  isUserOnline,
  getOnlineUserIds
};
