const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const validate = require('../middleware/validate');
const User = require('../models/User');

// Input validators
const registerValidator = (req) => {
  const errors = [];
  const { name, username, email, password } = req.body;
  if (!name || name.trim().length < 2) errors.push('Name must be at least 2 characters long');
  if (!username || username.trim().length < 3) errors.push('Username must be at least 3 characters long');
  if (!email || !/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(email)) errors.push('A valid email address is required');
  if (!password || password.length < 6) errors.push('Password must be at least 6 characters long');
  return errors;
};

const loginValidator = (req) => {
  const errors = [];
  const { identifier, email, username, password } = req.body;
  if (!identifier && !email && !username) errors.push('Email or username is required');
  if (!password) errors.push('Password is required');
  return errors;
};

// Routes
router.post('/register', authLimiter, validate(registerValidator), authController.register);
router.post('/login', authLimiter, validate(loginValidator), authController.login);
router.post('/logout', protect, authController.logout);
router.get('/me', protect, authController.getMe);
router.post('/verify-email', authController.verifyEmail);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);
router.post('/change-password', protect, authController.changePassword);
router.get('/check-username/:username', async (req, res, next) => {
  try {
    const { username } = req.params;
    if (!username || username.trim().length < 3) {
      return res.status(200).json({ success: true, available: false });
    }
    const user = await User.findOne({ username: username.toLowerCase().trim() });
    return res.status(200).json({ success: true, available: !user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
