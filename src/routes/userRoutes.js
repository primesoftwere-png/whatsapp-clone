const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { uploadSingle } = require('../middleware/upload');

// User search & contacts (placed before /:username to avoid route conflict)
router.get('/search', userController.searchUsers);
router.get('/contacts', userController.getContacts);

// Current user profile updates
router.patch('/me', userController.updateProfile);
router.patch('/me/avatar', uploadSingle('avatar'), userController.updateAvatar);
router.patch('/me/privacy', userController.updatePrivacySettings);

// Public user profile by username
router.get('/:username', userController.getUserProfile);

module.exports = router;
