const User = require('../models/User');
const Block = require('../models/Block');
const ContactRequest = require('../models/ContactRequest');
const ApiError = require('../utils/ApiError');
const { formatUserResponse, parsePagination } = require('../utils/helpers');

/**
 * @desc    Search users by name or username
 * @route   GET /api/users/search
 * @access  Private
 */
const searchUsers = async (req, res, next) => {
  try {
    const query = req.query.query || req.query.q;
    if (!query || query.trim().length === 0) {
      return res.status(200).json({ success: true, users: [], total: 0 });
    }

    const { page, limit, skip } = parsePagination(req.query);

    // Find all blocked user IDs (both ways)
    const blocks = await Block.find({
      $or: [{ blocker: req.user._id }, { blocked: req.user._id }]
    });

    const excludedIds = [
      req.user._id,
      ...blocks.map((b) => (b.blocker.toString() === req.user._id.toString() ? b.blocked : b.blocker))
    ];

    const searchRegex = new RegExp(query.trim(), 'i');

    const filter = {
      _id: { $nin: excludedIds },
      $or: [{ username: searchRegex }, { name: searchRegex }]
    };

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('name username avatar bio isOnline lastSeen privacySettings')
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    // Respect privacy settings for returned users
    const sanitized = users.map((u) => {
      const copy = { ...u };
      if (copy.privacySettings?.showOnlineStatus === 'nobody') {
        delete copy.isOnline;
      }
      if (copy.privacySettings?.showLastSeen === 'nobody') {
        delete copy.lastSeen;
      }
      return copy;
    });

    res.status(200).json({
      success: true,
      users: sanitized,
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
 * @desc    Get user profile by username
 * @route   GET /api/users/:username
 * @access  Private
 */
const getUserProfile = async (req, res, next) => {
  try {
    const { username } = req.params;
    const user = await User.findOne({ username: username.toLowerCase() });

    if (!user) {
      return next(ApiError.notFound('User not found'));
    }

    // Check if blocked
    const isBlocked = await Block.findOne({
      $or: [
        { blocker: req.user._id, blocked: user._id },
        { blocker: user._id, blocked: req.user._id }
      ]
    });

    if (isBlocked) {
      return next(ApiError.forbidden('Cannot view this profile'));
    }

    // Format and apply privacy settings
    const userObj = user.toObject();
    delete userObj.password;
    delete userObj.emailVerificationToken;
    delete userObj.resetPasswordToken;

    if (userObj.privacySettings?.showOnlineStatus === 'nobody') {
      delete userObj.isOnline;
    }
    if (userObj.privacySettings?.showLastSeen === 'nobody') {
      delete userObj.lastSeen;
    }

    res.status(200).json({
      success: true,
      user: userObj
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update current user's profile
 * @route   PATCH /api/users/me
 * @access  Private
 */
const updateProfile = async (req, res, next) => {
  try {
    const { name, bio, username } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return next(ApiError.notFound('User not found'));
    }

    if (username && username.toLowerCase() !== user.username) {
      const existing = await User.findOne({ username: username.toLowerCase() });
      if (existing) {
        return next(ApiError.conflict('Username is already taken'));
      }
      user.username = username.toLowerCase();
    }

    if (name !== undefined) user.name = name.trim();
    if (bio !== undefined) user.bio = bio.trim();

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update user avatar
 * @route   PATCH /api/users/me/avatar
 * @access  Private
 */
const updateAvatar = async (req, res, next) => {
  try {
    let avatarUrl = '';

    if (req.file) {
      avatarUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.avatar) {
      avatarUrl = req.body.avatar;
    } else {
      return next(ApiError.badRequest('Please upload an image file or provide avatar URL'));
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { avatar: avatarUrl },
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: 'Avatar updated successfully',
      avatar: avatarUrl,
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update user privacy settings
 * @route   PATCH /api/users/me/privacy
 * @access  Private
 */
const updatePrivacySettings = async (req, res, next) => {
  try {
    const { showOnlineStatus, showLastSeen, showReadReceipts, allowContactRequests } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return next(ApiError.notFound('User not found'));
    }

    if (showOnlineStatus) user.privacySettings.showOnlineStatus = showOnlineStatus;
    if (showLastSeen) user.privacySettings.showLastSeen = showLastSeen;
    if (showReadReceipts !== undefined) user.privacySettings.showReadReceipts = !!showReadReceipts;
    if (allowContactRequests) user.privacySettings.allowContactRequests = allowContactRequests;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Privacy settings updated successfully',
      privacySettings: user.privacySettings
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get contacts list for current user
 * @route   GET /api/users/contacts
 * @access  Private
 */
const getContacts = async (req, res, next) => {
  try {
    // Find accepted contact requests with lean projection
    const acceptedRequests = await ContactRequest.find({
      status: 'accepted',
      $or: [{ from: req.user._id }, { to: req.user._id }]
    })
      .populate('from', 'name username avatar bio isOnline lastSeen privacySettings')
      .populate('to', 'name username avatar bio isOnline lastSeen privacySettings')
      .lean();

    // Extract the contact (the other person)
    const contacts = acceptedRequests.map((reqDoc) => {
      const contactUser = reqDoc.from._id.toString() === req.user._id.toString()
        ? reqDoc.to
        : reqDoc.from;

      const obj = contactUser.toObject ? contactUser.toObject() : contactUser;
      if (obj.privacySettings?.showOnlineStatus === 'nobody') delete obj.isOnline;
      if (obj.privacySettings?.showLastSeen === 'nobody') delete obj.lastSeen;

      return {
        ...obj,
        contactRequestId: reqDoc._id,
        connectedSince: reqDoc.updatedAt
      };
    });

    res.status(200).json({
      success: true,
      contacts
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  searchUsers,
  getUserProfile,
  updateProfile,
  updateAvatar,
  updatePrivacySettings,
  getContacts
};
