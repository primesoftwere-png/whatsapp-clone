const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Report = require('../models/Report');
const ApiError = require('../utils/ApiError');
const { parsePagination, isValidObjectId } = require('../utils/helpers');

/**
 * @desc    Get system dashboard statistics
 * @route   GET /api/admin/stats
 * @access  Private (Admin)
 */
const getDashboardStats = async (req, res, next) => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalUsers, activeUsers24h, totalMessages, totalConversations, pendingReports] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ lastSeen: { $gte: oneDayAgo } }),
        Message.countDocuments({ isDeleted: false }),
        Conversation.countDocuments(),
        Report.countDocuments({ status: 'pending' })
      ]);

    res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        activeUsers24h,
        totalMessages,
        totalConversations,
        pendingReports
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all users (paginated, with search)
 * @route   GET /api/admin/users
 * @access  Private (Admin)
 */
const getUsers = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, 25);
    const filter = {};

    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search.trim(), 'i');
      filter.$or = [{ username: searchRegex }, { name: searchRegex }, { email: searchRegex }];
    }

    if (req.query.role) {
      filter.role = req.query.role;
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('-password -emailVerificationToken -resetPasswordToken')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update user status / role (Admin only)
 * @route   PATCH /api/admin/users/:id/status
 * @access  Private (Admin)
 */
const updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid user ID'));
    }

    const user = await User.findById(id);
    if (!user) {
      return next(ApiError.notFound('User not found'));
    }

    if (role && ['user', 'admin'].includes(role)) {
      user.role = role;
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: 'User status updated successfully',
      user: {
        _id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDashboardStats,
  getUsers,
  updateUserStatus
};
