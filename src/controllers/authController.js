const crypto = require('crypto');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { generateToken, getCookieOptions } = require('../utils/generateToken');
const { formatUserResponse } = require('../utils/helpers');

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = async (req, res, next) => {
  try {
    const { name, username, email, password } = req.body;

    if (!name || !username || !email || !password) {
      return next(ApiError.badRequest('Please provide name, username, email, and password'));
    }

    // Check if email exists
    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) {
      return next(ApiError.conflict('An account with this email already exists'));
    }

    // Check if username exists
    const existingUsername = await User.findOne({ username: username.toLowerCase() });
    if (existingUsername) {
      return next(ApiError.conflict('Username is already taken'));
    }

    // Create user
    const user = await User.create({
      name,
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password,
      isOnline: true,
      lastSeen: new Date()
    });

    const token = generateToken(user._id);
    const cookieOptions = getCookieOptions();

    res.cookie('nexchat_token', token, cookieOptions);

    res.status(201).json({
      success: true,
      message: 'Account registered successfully',
      token,
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Log in user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = async (req, res, next) => {
  try {
    const { identifier, email, username, password } = req.body;
    const loginIdentifier = identifier || email || username;

    if (!loginIdentifier || !password) {
      return next(ApiError.badRequest('Please provide email/username and password'));
    }

    // Support logging in via email or username
    const user = await User.findOne({
      $or: [
        { email: loginIdentifier.toLowerCase() },
        { username: loginIdentifier.toLowerCase() }
      ]
    }).select('+password');

    if (!user) {
      return next(ApiError.unauthorized('Invalid login credentials'));
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return next(ApiError.unauthorized('Invalid login credentials'));
    }

    // Update status
    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();

    const token = generateToken(user._id);
    const cookieOptions = getCookieOptions();

    res.cookie('nexchat_token', token, cookieOptions);

    res.status(200).json({
      success: true,
      message: 'Logged in successfully',
      token,
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Log out user / clear cookie
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = async (req, res, next) => {
  try {
    if (req.user) {
      await User.findByIdAndUpdate(req.user._id, {
        isOnline: false,
        lastSeen: new Date()
      });
    }

    const cookieOptions = getCookieOptions();
    res.clearCookie('nexchat_token', {
      ...cookieOptions,
      maxAge: 0
    });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get currently logged in user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return next(ApiError.notFound('User not found'));
    }

    res.status(200).json({
      success: true,
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify email address with token
 * @route   POST /api/auth/verify-email
 * @access  Public
 */
const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return next(ApiError.badRequest('Verification token is required'));
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() }
    });

    if (!user) {
      return next(ApiError.badRequest('Invalid or expired verification token'));
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Generate password reset token
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return next(ApiError.badRequest('Email is required'));
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Return 200 to prevent email enumeration
      return res.status(200).json({
        success: true,
        message: 'If an account with that email exists, a password reset token has been issued.'
      });
    }

    // Generate random reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password reset token generated',
      // In development, return the raw token directly
      ...(process.env.NODE_ENV !== 'production' && { resetToken })
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Reset password using reset token
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return next(ApiError.badRequest('Reset token and new password are required'));
    }

    if (newPassword.length < 6) {
      return next(ApiError.badRequest('Password must be at least 6 characters'));
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() }
    }).select('+password');

    if (!user) {
      return next(ApiError.badRequest('Invalid or expired reset token'));
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    const authToken = generateToken(user._id);
    res.cookie('nexchat_token', authToken, getCookieOptions());

    res.status(200).json({
      success: true,
      message: 'Password reset successful',
      token: authToken,
      user: formatUserResponse(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Change password for authenticated user
 * @route   POST /api/auth/change-password
 * @access  Private
 */
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return next(ApiError.badRequest('Current password and new password are required'));
    }

    if (newPassword.length < 6) {
      return next(ApiError.badRequest('New password must be at least 6 characters'));
    }

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return next(ApiError.badRequest('Current password does not match'));
    }

    user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  logout,
  getMe,
  verifyEmail,
  forgotPassword,
  resetPassword,
  changePassword
};
