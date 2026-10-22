const ApiError = require('./ApiError');

const errorHandler = (err, req, res, next) => {
  let error = err;

  // Mongoose CastError (e.g. invalid ObjectId)
  if (err.name === 'CastError') {
    const message = `Invalid resource identifier: ${err.path} = ${err.value}`;
    error = new ApiError(400, message);
  }

  // Mongoose duplicate key error (code 11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    const value = err.keyValue ? err.keyValue[field] : '';
    const message = `Duplicate value '${value}' for field '${field}'. Please use another value.`;
    error = new ApiError(409, message);
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    const message = `Validation error: ${messages.join('. ')}`;
    error = new ApiError(400, message);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = new ApiError(401, 'Invalid authentication token. Please log in again.');
  }

  if (err.name === 'TokenExpiredError') {
    error = new ApiError(401, 'Your authentication token has expired. Please log in again.');
  }

  // Multer error handling
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      error = new ApiError(400, 'File size exceeds allowed limit (max 10MB)');
    } else {
      error = new ApiError(400, `File upload error: ${err.message}`);
    }
  }

  // MongoDB / Database connection down or timeout
  const isDatabaseError =
    err.name === 'MongoServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    err.name === 'MongoTimeoutError' ||
    err.name === 'MongooseServerSelectionError' ||
    err.name === 'MongoNotConnectedError' ||
    (err.name === 'MongooseError' && err.message?.includes('buffering timed out')) ||
    (err.message && (
      (err.message.includes('ECONNREFUSED') && err.message.includes('27017')) ||
      err.message.includes('Topology is closed') ||
      err.message.includes('connection disconnected') ||
      err.message.includes('server closed the connection')
    ));

  if (isDatabaseError) {
    error = new ApiError(503, 'Database service is temporarily unavailable. Please try again shortly.');
    error.isDatabaseDown = true;
  }

  const statusCode = error.statusCode || 500;
  const status = error.status || 'error';
  const message = error.message || 'Internal server error';

  if (statusCode === 500 && process.env.NODE_ENV !== 'production') {
    console.error('Unhandled Server Error:', err);
  }

  res.status(statusCode).json({
    success: false,
    status,
    message,
    ...(process.env.NODE_ENV === 'development' && {
      stack: err.stack,
      error: err
    })
  });
};

module.exports = errorHandler;
