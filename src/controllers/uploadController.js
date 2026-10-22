const path = require('path');
const fs = require('fs');
const ApiError = require('../utils/ApiError');
const { uploadDir } = require('../middleware/upload');

/**
 * @desc    Upload single file
 * @route   POST /api/uploads
 * @access  Private
 */
const uploadFile = async (req, res, next) => {
  try {
    if (!req.file && (!req.files || req.files.length === 0)) {
      return next(ApiError.badRequest('Please attach a file to upload'));
    }

    if (req.file) {
      const fileUrl = `/uploads/${req.file.filename}`;
      return res.status(201).json({
        success: true,
        message: 'File uploaded successfully',
        file: {
          filename: req.file.filename,
          originalName: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          url: fileUrl
        }
      });
    }

    // If multiple files
    const files = req.files.map((f) => ({
      filename: f.filename,
      originalName: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      url: `/uploads/${f.filename}`
    }));

    res.status(201).json({
      success: true,
      message: `${files.length} files uploaded successfully`,
      files
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get / download uploaded file
 * @route   GET /api/uploads/:filename
 * @access  Private
 */
const getFile = async (req, res, next) => {
  try {
    const { filename } = req.params;
    // Prevent directory traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(uploadDir, safeFilename);

    if (!fs.existsSync(filePath)) {
      return next(ApiError.notFound('File not found'));
    }

    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  uploadFile,
  getFile
};
