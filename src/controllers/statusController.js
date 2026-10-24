const Status = require('../models/Status');
const Block = require('../models/Block');
const ApiError = require('../utils/ApiError');
const { getIO } = require('../config/socket');

/**
 * @desc    Create a new status (photo or video)
 * @route   POST /api/status
 * @access  Private
 */
const createStatus = async (req, res, next) => {
  try {
    let mediaUrl = req.body.mediaUrl;
    let type = req.body.type || 'image';

    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
      if (req.file.mimetype && req.file.mimetype.startsWith('video/')) {
        type = 'video';
      } else {
        type = 'image';
      }
    }

    if (!mediaUrl) {
      return next(ApiError.badRequest('Please upload an image or video file for your status'));
    }

    const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : '';

    const newStatus = await Status.create({
      user: req.user._id,
      type,
      mediaUrl,
      caption,
      likes: [],
      viewers: []
    });

    const populatedStatus = await Status.findById(newStatus._id)
      .populate('user', '_id name username avatar')
      .populate('likes', '_id name username avatar');

    // Broadcast new status via Socket.IO
    try {
      const io = getIO();
      if (io) {
        io.emit('status:new', populatedStatus);
      }
    } catch (socketErr) {
      console.warn('[Socket] Could not emit status:new', socketErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Status created successfully',
      status: populatedStatus
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get active statuses (grouped into my statuses and others)
 * @route   GET /api/status
 * @access  Private
 */
const getStatuses = async (req, res, next) => {
  try {
    const currentUserId = req.user._id.toString();

    // Find any blocks involving the current user
    const blocks = await Block.find({
      $or: [{ blocker: req.user._id }, { blocked: req.user._id }]
    }).lean();

    const blockedUserIds = new Set(
      blocks.map((b) =>
        b.blocker.toString() === currentUserId ? b.blocked.toString() : b.blocker.toString()
      )
    );

    // Fetch active statuses (expires in future)
    const activeStatuses = await Status.find({
      expiresAt: { $gt: new Date() }
    })
      .sort({ createdAt: -1 })
      .populate('user', '_id name username avatar')
      .populate('likes', '_id name username avatar')
      .populate('viewers.user', '_id name username avatar')
      .lean();

    const myStatuses = [];
    const userGroupsMap = new Map();

    for (const st of activeStatuses) {
      if (!st.user) continue;
      const statusAuthorId = st.user._id.toString();

      // Skip statuses from blocked users
      if (blockedUserIds.has(statusAuthorId)) {
        continue;
      }

      if (statusAuthorId === currentUserId) {
        myStatuses.push(st);
      } else {
        if (!userGroupsMap.has(statusAuthorId)) {
          userGroupsMap.set(statusAuthorId, {
            user: st.user,
            latestStatusAt: st.createdAt,
            statuses: []
          });
        }
        userGroupsMap.get(statusAuthorId).statuses.push(st);
      }
    }

    // Convert map to array sorted by latest status update
    const otherStatuses = Array.from(userGroupsMap.values()).sort(
      (a, b) => new Date(b.latestStatusAt).getTime() - new Date(a.latestStatusAt).getTime()
    );

    res.status(200).json({
      success: true,
      myStatuses,
      otherStatuses
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a status
 * @route   DELETE /api/status/:id
 * @access  Private
 */
const deleteStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const status = await Status.findById(id);

    if (!status) {
      return next(ApiError.notFound('Status not found'));
    }

    // Only status owner can delete
    if (status.user.toString() !== req.user._id.toString()) {
      return next(ApiError.forbidden('You are not authorized to delete this status'));
    }

    await Status.findByIdAndDelete(id);

    // Broadcast deletion via Socket.IO
    try {
      const io = getIO();
      if (io) {
        io.emit('status:deleted', { statusId: id, userId: req.user._id });
      }
    } catch (socketErr) {
      console.warn('[Socket] Could not emit status:deleted', socketErr.message);
    }

    res.status(200).json({
      success: true,
      message: 'Status deleted successfully',
      statusId: id
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Like or unlike a status
 * @route   POST /api/status/:id/like
 * @access  Private
 */
const likeStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user._id.toString();

    const status = await Status.findById(id);
    if (!status) {
      return next(ApiError.notFound('Status not found'));
    }

    const alreadyLikedIndex = status.likes.findIndex(
      (likeId) => likeId.toString() === currentUserId
    );

    let isLiked = false;
    if (alreadyLikedIndex !== -1) {
      // Unlike
      status.likes.splice(alreadyLikedIndex, 1);
      isLiked = false;
    } else {
      // Like
      status.likes.push(req.user._id);
      isLiked = true;
    }

    await status.save();

    // Broadcast like event via Socket.IO
    try {
      const io = getIO();
      if (io) {
        io.emit('status:liked', {
          statusId: id,
          userId: req.user._id,
          likes: status.likes,
          likesCount: status.likes.length,
          isLiked
        });
      }
    } catch (socketErr) {
      console.warn('[Socket] Could not emit status:liked', socketErr.message);
    }

    res.status(200).json({
      success: true,
      isLiked,
      likesCount: status.likes.length,
      likes: status.likes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Mark a status as viewed
 * @route   POST /api/status/:id/view
 * @access  Private
 */
const viewStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user._id.toString();

    const status = await Status.findById(id);
    if (!status) {
      return next(ApiError.notFound('Status not found'));
    }

    const hasViewed = status.viewers.some(
      (v) => v.user && v.user.toString() === currentUserId
    );

    if (!hasViewed) {
      status.viewers.push({
        user: req.user._id,
        viewedAt: new Date()
      });
      await status.save();
    }

    res.status(200).json({
      success: true,
      message: 'Status marked as viewed'
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createStatus,
  getStatuses,
  deleteStatus,
  likeStatus,
  viewStatus
};
