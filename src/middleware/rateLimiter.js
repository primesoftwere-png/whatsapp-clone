const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

const defaultOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  // Disable strict x-forwarded-for validation check on reverse proxies (Render, AWS, Cloudflare)
  validate: {
    xForwardedForHeader: false,
    default: true,
  },
};

const authLimiter = rateLimit({
  ...defaultOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 1000 : 30,
  message: {
    success: false,
    status: 'fail',
    message: 'Too many authentication attempts from this IP, please try again after 15 minutes.'
  }
});

const apiLimiter = rateLimit({
  ...defaultOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 10000 : 2000,
  skip: (req) => isDev && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
  message: {
    success: false,
    status: 'fail',
    message: 'Too many requests from this IP, please try again later.'
  }
});

const messageLimiter = rateLimit({
  ...defaultOptions,
  windowMs: 60 * 1000, // 1 minute
  max: isDev ? 1000 : 120,
  message: {
    success: false,
    status: 'fail',
    message: 'Message rate limit exceeded. Please slow down.'
  }
});

module.exports = {
  authLimiter,
  apiLimiter,
  messageLimiter
};
