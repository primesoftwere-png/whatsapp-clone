const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { uploadSingle, uploadArray } = require('../middleware/upload');

// Single file upload
router.post('/', uploadSingle('file'), uploadController.uploadFile);

// Multiple file upload
router.post('/multiple', uploadArray('files', 5), uploadController.uploadFile);

// Direct download / get file
router.get('/:filename', uploadController.getFile);

module.exports = router;
