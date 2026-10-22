const Notification = require('../models/Notification');
const ApiError = require('../utils/ApiError');
const { parsePagination, isValidObjectId } = require('../utils/helpers');

/**
 * @desc    Get user notifications (paginated)
 * @route   GET /api/notifications
 * @access  Private
 */
const getNotifications = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, 20);

    const filter = { user: req.user._id };

    if (req.query.unreadOnly === 'true') {
      filter.isRead = false;
    }

    const total = await Notification.countDocuments(filter);
    const unreadCount = await Notification.countDocuments({ user: req.user._id, isRead: false });

    const notifications = await Notification.find(filter)
      .populate('relatedUser', 'name username avatar')
      .populate('relatedConversation', 'name type')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      notifications,
      unreadCount,
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
 * @desc    Mark a single notification as read
 * @route   PATCH /api/notifications/:id/read
 * @access  Private
 */
const markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid notification ID'));
    }

    const notification = await Notification.findOne({
      _id: id,
      user: req.user._id
    });

    if (!notification) {
      return next(ApiError.notFound('Notification not found'));
    }

    notification.isRead = true;
    await notification.save();

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      notification
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Mark all user's notifications as read
 * @route   PATCH /api/notifications/read-all
 * @access  Private
 */
const markAllAsRead = async (req, res, next) => {
  try {
    const result = await Notification.updateMany(
      { user: req.user._id, isRead: false },
      { isRead: true }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a single notification
 * @route   DELETE /api/notifications/:id
 * @access  Private
 */
const deleteNotification = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid notification ID'));
    }

    const result = await Notification.findOneAndDelete({
      _id: id,
      user: req.user._id
    });

    if (!result) {
      return next(ApiError.notFound('Notification not found'));
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification
};
