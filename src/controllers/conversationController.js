const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Block = require('../models/Block');
const ApiError = require('../utils/ApiError');
const { parsePagination, isValidObjectId } = require('../utils/helpers');
const redisService = require('../config/redis');

/**
 * @desc    Get user's conversations
 * @route   GET /api/conversations
 * @access  Private
 */
const getConversations = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, 20);

    const filter = {
      'participants.user': req.user._id
    };

    if (req.query.type) {
      filter.type = req.query.type;
    }

    if (req.query.archived !== undefined) {
      filter.isArchived = req.query.archived === 'true';
    }

    const cacheKey = `user:convs:${req.user._id}:${page}:${limit}:${req.query.type || 'all'}:${req.query.archived || 'active'}`;

    // Quick cache lookup for page 1 to minimize loading times
    if (page === 1) {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return res.status(200).json(parsed);
        } catch {
          // ignore corrupted cache
        }
      }
    }

    // Parallel execution with lean() projection for maximum throughput
    const [total, conversations] = await Promise.all([
      Conversation.countDocuments(filter),
      Conversation.find(filter)
        .populate('participants.user', 'name username avatar isOnline lastSeen')
        .populate('lastMessage.sender', 'name username')
        .sort({ isPinned: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    const result = {
      success: true,
      conversations,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };

    // Cache page 1 for 10 seconds to eliminate redundant DB pressure
    if (page === 1) {
      await redisService.set(cacheKey, JSON.stringify(result), 10);
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create a private or group conversation
 * @route   POST /api/conversations
 * @access  Private
 */
const createConversation = async (req, res, next) => {
  try {
    const type = req.body.type || (req.body.recipientId || req.body.participantId ? 'private' : 'group');
    const recipientId = req.body.recipientId || req.body.participantId;
    const participantIds = req.body.participantIds || [];
    const { name, description, avatar } = req.body;

    if (!type || !['private', 'group'].includes(type)) {
      return next(ApiError.badRequest('Conversation type must be "private" or "group"'));
    }

    // 1. PRIVATE CONVERSATION
    if (type === 'private') {
      if (!recipientId) {
        return next(ApiError.badRequest('recipientId is required for private conversations'));
      }

      if (recipientId.toString() === req.user._id.toString()) {
        return next(ApiError.badRequest('Cannot start a conversation with yourself'));
      }

      const recipient = await User.findById(recipientId);
      if (!recipient) {
        return next(ApiError.notFound('Recipient user not found'));
      }

      // Check if blocked
      const isBlocked = await Block.findOne({
        $or: [
          { blocker: req.user._id, blocked: recipientId },
          { blocker: recipientId, blocked: req.user._id }
        ]
      });

      if (isBlocked) {
        return next(ApiError.forbidden('Cannot create conversation due to block status'));
      }

      // Check if private conversation already exists
      let existingConv = await Conversation.findOne({
        type: 'private',
        'participants.user': { $all: [req.user._id, recipientId] }
      }).populate('participants.user', 'name username avatar isOnline lastSeen');

      if (existingConv) {
        return res.status(200).json({
          success: true,
          message: 'Existing conversation returned',
          conversation: existingConv
        });
      }

      const newConv = await Conversation.create({
        type: 'private',
        participants: [
          { user: req.user._id, role: 'owner', joinedAt: new Date() },
          { user: recipientId, role: 'member', joinedAt: new Date() }
        ],
        createdBy: req.user._id
      });

      const populatedConv = await Conversation.findById(newConv._id).populate(
        'participants.user',
        'name username avatar isOnline lastSeen'
      );

      return res.status(201).json({
        success: true,
        conversation: populatedConv
      });
    }

    // 2. GROUP CONVERSATION
    if (type === 'group') {
      if (!name || name.trim().length === 0) {
        return next(ApiError.badRequest('Group name is required'));
      }

      const uniqueMemberIds = Array.from(
        new Set(
          participantIds
            .filter((id) => isValidObjectId(id) && id.toString() !== req.user._id.toString())
        )
      );

      const participants = [
        { user: req.user._id, role: 'owner', joinedAt: new Date() },
        ...uniqueMemberIds.map((id) => ({
          user: id,
          role: 'member',
          joinedAt: new Date()
        }))
      ];

      const newGroup = await Conversation.create({
        type: 'group',
        name: name.trim(),
        description: description ? description.trim() : '',
        avatar: avatar || '',
        participants,
        createdBy: req.user._id
      });

      const populatedGroup = await Conversation.findById(newGroup._id)
        .populate('participants.user', 'name username avatar isOnline lastSeen')
        .populate('createdBy', 'name username');

      return res.status(201).json({
        success: true,
        conversation: populatedGroup
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single conversation details
 * @route   GET /api/conversations/:id
 * @access  Private
 */
const getConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid conversation ID'));
    }

    const conversation = await Conversation.findById(id)
      .populate('participants.user', 'name username avatar bio isOnline lastSeen')
      .populate('createdBy', 'name username');

    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    // Verify user is participant
    const isMember = conversation.participants.some(
      (p) => p.user && p.user._id.toString() === req.user._id.toString()
    );

    if (!isMember) {
      return next(ApiError.forbidden('You are not a participant in this conversation'));
    }

    res.status(200).json({
      success: true,
      conversation
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update conversation (group info)
 * @route   PATCH /api/conversations/:id
 * @access  Private
 */
const updateConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, avatar } = req.body;

    const conversation = await Conversation.findById(id);
    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    if (conversation.type !== 'group') {
      return next(ApiError.badRequest('Only group conversations can be updated via this endpoint'));
    }

    // Check if user is admin or owner of group
    const participant = conversation.participants.find(
      (p) => p.user.toString() === req.user._id.toString()
    );

    if (!participant || !['admin', 'owner'].includes(participant.role)) {
      return next(ApiError.forbidden('Only group administrators or owners can update group details'));
    }

    if (name) conversation.name = name.trim();
    if (description !== undefined) conversation.description = description.trim();
    if (avatar !== undefined) conversation.avatar = avatar;

    await conversation.save();

    const updated = await Conversation.findById(id)
      .populate('participants.user', 'name username avatar isOnline lastSeen')
      .populate('createdBy', 'name username');

    res.status(200).json({
      success: true,
      message: 'Group updated successfully',
      conversation: updated
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Toggle archive status of conversation
 * @route   PATCH /api/conversations/:id/archive
 * @access  Private
 */
const archiveConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    const isMember = conversation.participants.some(
      (p) => p.user.toString() === req.user._id.toString()
    );
    if (!isMember) {
      return next(ApiError.forbidden('Not a member of this conversation'));
    }

    conversation.isArchived = !conversation.isArchived;
    await conversation.save();

    res.status(200).json({
      success: true,
      message: `Conversation ${conversation.isArchived ? 'archived' : 'unarchived'} successfully`,
      isArchived: conversation.isArchived
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Toggle mute status of conversation
 * @route   PATCH /api/conversations/:id/mute
 * @access  Private
 */
const muteConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    const isMember = conversation.participants.some(
      (p) => p.user.toString() === req.user._id.toString()
    );
    if (!isMember) {
      return next(ApiError.forbidden('Not a member of this conversation'));
    }

    conversation.isMuted = !conversation.isMuted;
    await conversation.save();

    res.status(200).json({
      success: true,
      message: `Conversation ${conversation.isMuted ? 'muted' : 'unmuted'} successfully`,
      isMuted: conversation.isMuted
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Toggle pin status of conversation
 * @route   PATCH /api/conversations/:id/pin
 * @access  Private
 */
const pinConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return next(ApiError.notFound('Conversation not found'));
    }

    const isMember = conversation.participants.some(
      (p) => p.user.toString() === req.user._id.toString()
    );
    if (!isMember) {
      return next(ApiError.forbidden('Not a member of this conversation'));
    }

    conversation.isPinned = !conversation.isPinned;
    await conversation.save();

    res.status(200).json({
      success: true,
      message: `Conversation ${conversation.isPinned ? 'pinned' : 'unpinned'} successfully`,
      isPinned: conversation.isPinned
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getConversations,
  createConversation,
  getConversation,
  updateConversation,
  archiveConversation,
  muteConversation,
  pinConversation
};
