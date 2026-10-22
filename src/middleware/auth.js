const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');

/**
 * Protect middleware - ensures user is authenticated via JWT token in cookie or Authorization header
 */
const protect = async (req, res, next) => {
  try {
    let token = null;

    // Check cookie first (nexchat_token)
    if (req.cookies && req.cookies.nexchat_token) {
      token = req.cookies.nexchat_token;
    }
    // Check Authorization header: Bearer <token>
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(ApiError.unauthorized('Authentication required. Please log in.'));
    }

    // Verify token
    const secret = process.env.JWT_SECRET || 'nexchat_jwt_secret_change_in_production_2024';
    const decoded = jwt.verify(token, secret);

    // Retrieve user from DB
    const user = await User.findById(decoded.id);
    if (!user) {
      return next(ApiError.unauthorized('The user belonging to this token no longer exists.'));
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(ApiError.unauthorized('Invalid authentication token.'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('Your session has expired. Please log in again.'));
    }
    next(error);
  }
};

/**
 * Admin only middleware
 */
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return next(ApiError.forbidden('Admin access required for this action.'));
  }
  next();
};

module.exports = {
  protect,
  adminOnly
};
