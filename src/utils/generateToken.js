const jwt = require('jsonwebtoken');

const generateToken = (userId) => {
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET || 'nexchat_jwt_secret_change_in_production_2024',
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    }
  );
};

const getCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/'
  };
};

module.exports = {
  generateToken,
  getCookieOptions
};
