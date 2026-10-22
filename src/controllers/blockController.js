const Block = require('../models/Block');
const User = require('../models/User');
const ContactRequest = require('../models/ContactRequest');
const ApiError = require('../utils/ApiError');
const { isValidObjectId } = require('../utils/helpers');

/**
 * @desc    Block a user
 * @route   POST /api/blocks
 * @access  Private
 */
const blockUser = async (req, res, next) => {
  try {
    const { userId } = req.body;

    if (!userId || !isValidObjectId(userId)) {
      return next(ApiError.badRequest('Valid userId is required'));
    }

    if (userId.toString() === req.user._id.toString()) {
      return next(ApiError.badRequest('You cannot block yourself'));
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return next(ApiError.notFound('User to block was not found'));
    }

    // Check if already blocked
    const existingBlock = await Block.findOne({
      blocker: req.user._id,
      blocked: userId
    });

    if (existingBlock) {
      return res.status(200).json({
        success: true,
        message: 'User is already blocked',
        block: existingBlock
      });
    }

    const block = await Block.create({
      blocker: req.user._id,
      blocked: userId
    });

    // Clean up any pending or accepted contact requests
    await ContactRequest.updateMany(
      {
        $or: [
          { from: req.user._id, to: userId },
          { from: userId, to: req.user._id }
        ]
      },
      { status: 'cancelled' }
    );

    res.status(201).json({
      success: true,
      message: 'User blocked successfully',
      block
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Unblock a user
 * @route   DELETE /api/blocks/:userId
 * @access  Private
 */
const unblockUser = async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (!isValidObjectId(userId)) {
      return next(ApiError.badRequest('Invalid user ID'));
    }

    const result = await Block.findOneAndDelete({
      blocker: req.user._id,
      blocked: userId
    });

    if (!result) {
      return next(ApiError.notFound('Block record not found'));
    }

    res.status(200).json({
      success: true,
      message: 'User unblocked successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all users blocked by current user
 * @route   GET /api/blocks
 * @access  Private
 */
const getBlockedUsers = async (req, res, next) => {
  try {
    const blocks = await Block.find({ blocker: req.user._id })
      .populate('blocked', 'name username avatar')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      blocks
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  blockUser,
  unblockUser,
  getBlockedUsers
};
