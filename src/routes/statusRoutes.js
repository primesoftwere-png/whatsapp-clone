const express = require('express');
const router = express.Router();
const statusController = require('../controllers/statusController');
const { uploadSingle } = require('../middleware/upload');

// Fetch all active statuses
router.get('/', statusController.getStatuses);

// Create new status (with image or video)
router.post('/', uploadSingle('media'), statusController.createStatus);

// Delete own status
router.delete('/:id', statusController.deleteStatus);

// Like / unlike status
router.post('/:id/like', statusController.likeStatus);

// Mark status as viewed
router.post('/:id/view', statusController.viewStatus);

module.exports = router;
