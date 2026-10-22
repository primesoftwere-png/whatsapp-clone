const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Block = require('../models/Block');
const ApiError = require('../utils/ApiError');
const { getIO } = require('../config/socket');
const { isValidObjectId } = require('../utils/helpers');

/**
 * @desc    Get messages for a conversation with cursor/limit pagination
 * @route   GET /api/messages/conversations/:conversationId/messages
 * @access  Private
 */
const getMessages = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { before, limit = 30 } = req.query;

    if (!isValidObjectId(conversationId)) {
      return next(ApiError.badRequest('Invalid conversation ID'));
    }

    // Verify membership
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    const isMember = conversation.participants.some(
      (p) => p.user.toString() === req.user._id.toString()
    );
    if (!isMember) {
      return next(ApiError.forbidden('You are not a participant in this conversation'));
    }

    const queryLimit = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const filter = { conversation: conversationId };

    // Cursor-based pagination: fetch messages created before a given message or date
    if (before) {
      if (isValidObjectId(before)) {
        const cursorMsg = await Message.findById(before);
        if (cursorMsg) {
          filter.createdAt = { $lt: cursorMsg.createdAt };
        }
      } else {
        const beforeDate = new Date(before);
        if (!isNaN(beforeDate.getTime())) {
          filter.createdAt = { $lt: beforeDate };
        }
      }
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(queryLimit)
      .populate('sender', 'name username avatar')
      .populate({
        path: 'replyTo',
        select: 'content sender type attachments',
        populate: { path: 'sender', select: 'name username' }
      })
      .lean();

    // Reverse so chronologically ordered for client (oldest to newest in the chunk)
    messages.reverse();

    const hasMore = messages.length === queryLimit;
    const nextCursor = messages.length > 0 ? messages[0]._id : null;

    res.status(200).json({
      success: true,
      messages,
      hasMore,
      nextCursor
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Send a message via HTTP REST endpoint
 * @route   POST /api/messages/conversations/:conversationId/messages
 * @access  Private
 */
const sendMessage = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { content, type = 'text', attachments = [], replyTo = null, clientMessageId } = req.body;

    if (!isValidObjectId(conversationId)) {
      return next(ApiError.badRequest('Invalid conversation ID'));
    }

    if (!content && (!attachments || attachments.length === 0)) {
      return next(ApiError.badRequest('Message content or attachments required'));
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    const isMember = conversation.participants.some(
      (p) => p.user.toString() === req.user._id.toString()
    );
    if (!isMember) {
      return next(ApiError.forbidden('You are not a participant in this conversation'));
    }

    // Check block status for private conversations
    if (conversation.type === 'private') {
      const otherParticipant = conversation.participants.find(
        (p) => p.user.toString() !== req.user._id.toString()
      );
      if (otherParticipant) {
        const blocked = await Block.findOne({
          $or: [
            { blocker: req.user._id, blocked: otherParticipant.user },
            { blocker: otherParticipant.user, blocked: req.user._id }
          ]
        });
        if (blocked) {
          return next(ApiError.forbidden('Cannot send message due to block settings'));
        }
      }
    }

    // Idempotency check
    if (clientMessageId) {
      const existing = await Message.findOne({ clientMessageId })
        .populate('sender', 'name username avatar')
        .populate({
          path: 'replyTo',
          select: 'content sender type attachments',
          populate: { path: 'sender', select: 'name username' }
        });
      if (existing) {
        return res.status(200).json({ success: true, message: existing });
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

    // Check recipient online/room presence for initial status
    let initialStatus = 'sent';
    const now = new Date();
    const deliveredToList = [{ user: req.user._id, deliveredAt: now }];
    const readByList = [];

    const { isUserOnline } = require('../config/socket');
    const otherParticipant = conversation.participants.find(
      (p) => p.user.toString() !== req.user._id.toString()
    );

    if (otherParticipant) {
      const otherUserId = otherParticipant.user.toString();
      if (isUserOnline(otherUserId)) {
        initialStatus = 'delivered';
        deliveredToList.push({ user: otherParticipant.user, deliveredAt: now });

        const ioInstance = getIO();
        if (ioInstance) {
          const room = ioInstance.sockets.adapter.rooms.get(`conv_${conversationId}`);
          const otherUserRoom = ioInstance.sockets.adapter.rooms.get(otherUserId);
          if (room && otherUserRoom) {
            for (const sockId of otherUserRoom) {
              if (room.has(sockId)) {
                initialStatus = 'read';
                readByList.push({ user: otherParticipant.user, readAt: now });
                break;
              }
            }
          }
        }
      }
    }

    const message = await Message.create({
      conversation: conversationId,
      sender: req.user._id,
      content: content || '',
      type,
      attachments: normalizedAttachments,
      replyTo: replyTo && isValidObjectId(replyTo) ? replyTo : null,
      clientMessageId: clientMessageId || undefined,
      status: initialStatus,
      deliveredTo: deliveredToList,
      readBy: readByList
    });

    // Update conversation lastMessage
    const lastMessageSnippet = type === 'text' ? content : `[${type}]`;
    conversation.lastMessage = {
      content: lastMessageSnippet,
      sender: req.user._id,
      timestamp: new Date(),
      type
    };
    await conversation.save();

    const populated = await Message.findById(message._id)
      .populate('sender', 'name username avatar')
      .populate({
        path: 'replyTo',
        select: 'content sender type attachments',
        populate: { path: 'sender', select: 'name username' }
      });

    // Emit via Socket.io
    const io = getIO();
    if (io) {
      io.to(`conv_${conversationId}`).emit('message:new', populated);
      conversation.participants.forEach((p) => {
        const pId = p.user.toString();
        io.to(pId).emit('conversation:lastMessage', {
          conversationId,
          lastMessage: conversation.lastMessage,
          message: populated
        });
      });
    }

    res.status(201).json({
      success: true,
      message: populated
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Edit a message
 * @route   PATCH /api/messages/:id
 * @access  Private
 */
const editMessage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid message ID'));
    }

    if (!content || content.trim().length === 0) {
      return next(ApiError.badRequest('New content is required'));
    }

    const message = await Message.findById(id);
    if (!message) {
      return next(ApiError.notFound('Message not found'));
    }

    if (message.sender.toString() !== req.user._id.toString()) {
      return next(ApiError.forbidden('Only message sender can edit message'));
    }

    if (message.isDeleted) {
      return next(ApiError.badRequest('Cannot edit deleted message'));
    }

    message.content = content.trim();
    message.isEdited = true;
    await message.save();

    const populated = await Message.findById(message._id)
      .populate('sender', 'name username avatar')
      .populate({
        path: 'replyTo',
        select: 'content sender type attachments',
        populate: { path: 'sender', select: 'name username' }
      });

    const io = getIO();
    if (io) {
      io.to(`conv_${message.conversation}`).emit('message:edited', populated);
    }

    res.status(200).json({
      success: true,
      message: populated
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Soft-delete a message
 * @route   DELETE /api/messages/:id
 * @access  Private
 */
const deleteMessage = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid message ID'));
    }

    const message = await Message.findById(id);
    if (!message) {
      return next(ApiError.notFound('Message not found'));
    }

    if (message.sender.toString() !== req.user._id.toString()) {
      return next(ApiError.forbidden('Only message sender can delete message'));
    }

    message.isDeleted = true;
    message.content = 'This message was deleted';
    message.attachments = [];
    await message.save();

    const io = getIO();
    if (io) {
      io.to(`conv_${message.conversation}`).emit('message:deleted', {
        messageId: message._id,
        conversationId: message.conversation
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully',
      messageId: message._id
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Mark message as read
 * @route   POST /api/messages/:id/read
 * @access  Private
 */
const markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid message ID'));
    }

    const message = await Message.findById(id);
    if (!message) {
      return next(ApiError.notFound('Message not found'));
    }

    const now = new Date();
    const alreadyRead = message.readBy.some(
      (r) => r.user.toString() === req.user._id.toString()
    );

    if (!alreadyRead) {
      message.readBy.push({ user: req.user._id, readAt: now });

      const alreadyDelivered = message.deliveredTo.some(
        (d) => d.user.toString() === req.user._id.toString()
      );
      if (!alreadyDelivered) {
        message.deliveredTo.push({ user: req.user._id, deliveredAt: now });
      }

      message.status = 'read';
      await message.save();

      const io = getIO();
      if (io) {
        io.to(message.sender.toString()).emit('message:receipt', {
          messageId: message._id,
          conversationId: message.conversation,
          userId: req.user._id,
          type: 'read',
          status: 'read',
          readAt: now
        });
        io.to(`conv_${message.conversation}`).emit('message:receipt', {
          messageId: message._id,
          conversationId: message.conversation,
          userId: req.user._id,
          type: 'read',
          status: 'read',
          readAt: now
        });
      }
    }

    res.status(200).json({
      success: true,
      message: 'Marked as read'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Mark all messages in a conversation as read
 * @route   POST /api/messages/conversations/:conversationId/read
 * @access  Private
 */
const markConversationAsRead = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    if (!isValidObjectId(conversationId)) {
      return next(ApiError.badRequest('Invalid conversation ID'));
    }

    const now = new Date();
    await Message.updateMany(
      {
        conversation: conversationId,
        sender: { $ne: req.user._id },
        status: { $ne: 'read' }
      },
      {
        $set: { status: 'read' },
        $addToSet: {
          readBy: { user: req.user._id, readAt: now },
          deliveredTo: { user: req.user._id, deliveredAt: now }
        }
      }
    );

    const io = getIO();
    if (io) {
      io.to(`conv_${conversationId}`).emit('message:receipt', {
        conversationId,
        userId: req.user._id,
        type: 'read',
        status: 'read',
        readAt: now
      });

      const conv = await Conversation.findById(conversationId).select('participants');
      if (conv && conv.participants) {
        conv.participants.forEach((p) => {
          const pId = p.user.toString();
          if (pId !== req.user._id.toString()) {
            io.to(pId).emit('message:receipt', {
              conversationId,
              userId: req.user._id,
              type: 'read',
              status: 'read',
              readAt: now
            });
          }
        });
      }
    }

    res.status(200).json({ success: true, message: 'Conversation marked as read' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markAsRead,
  markConversationAsRead
};
