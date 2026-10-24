const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ApiError = require('../utils/ApiError');

// Ensure upload directory exists
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueFilename = `${Date.now()}-${uuidv4()}${ext}`;
    cb(null, uniqueFilename);
  }
});

// File filter
const allowedMimeTypes = [
  // Images
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  // Videos
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/ogg',
  'video/3gpp',
  'video/x-matroska',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        400,
        `Unsupported file type: ${file.mimetype}. Allowed types: JPEG, PNG, GIF, WEBP, MP4, WEBM, MOV, PDF, DOC, DOCX, TXT`
      ),
      false
    );
  }
};

const maxFileSize = parseInt(process.env.MAX_FILE_SIZE, 10) || 50 * 1024 * 1024; // 50MB default

const upload = multer({
  storage,
  limits: {
    fileSize: maxFileSize
  },
  fileFilter
});

const uploadSingle = (fieldName = 'file') => upload.single(fieldName);
const uploadArray = (fieldName = 'files', maxCount = 5) => upload.array(fieldName, maxCount);

module.exports = {
  upload,
  uploadSingle,
  uploadArray,
  uploadDir
};
