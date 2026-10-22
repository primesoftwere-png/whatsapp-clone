require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const connectDB = require('./config/db');
const { initSocket } = require('./config/socket');
const errorHandler = require('./utils/errorHandler');
const ApiError = require('./utils/ApiError');
const { protect, adminOnly } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimiter');

// Import route handlers
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const messageRoutes = require('./routes/messageRoutes');
const contactRequestRoutes = require('./routes/contactRequestRoutes');
const blockRoutes = require('./routes/blockRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const reportRoutes = require('./routes/reportRoutes');
const adminRoutes = require('./routes/adminRoutes');
const uploadRoutes = require('./routes/uploadRoutes');

// Ensure local uploads directory exists
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`[Storage] Created uploads directory at ${uploadDir}`);
}

// Connect to MongoDB
connectDB();

// Initialize Express app & HTTP server
const app = express();
const server = http.createServer(app);

// Attach Socket.IO
initSocket(server);

// Security & Parsing Middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
app.use(
  cors({
    origin: clientUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  })
);

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static file serving for uploads
app.use('/uploads', express.static(uploadDir));

// Health check endpoint
app.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  const redisService = require('./config/redis');
  const dbConnected = mongoose.connection.readyState === 1;
  const redisConnected = redisService.isAvailable();

  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'ok' : 'degraded',
    database: dbConnected ? 'connected' : 'disconnected',
    redis: redisConnected ? 'connected' : 'fallback-in-memory',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// General API rate limiter
app.use('/api', apiLimiter);

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', protect, userRoutes);
app.use('/api/conversations', protect, conversationRoutes);
app.use('/api/messages', protect, messageRoutes);
app.use('/api/contact-requests', protect, contactRequestRoutes);
app.use('/api/blocks', protect, blockRoutes);
app.use('/api/notifications', protect, notificationRoutes);
app.use('/api/reports', protect, reportRoutes);
app.use('/api/admin', protect, adminOnly, adminRoutes);
app.use('/api/uploads', protect, uploadRoutes);

// Catch-all for unhandled routes
app.use((req, res, next) => {
  next(new ApiError(404, `Cannot find ${req.originalUrl} on this server`));
});

// Global Error Handler
app.use(errorHandler);

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` NexChat Messaging Server Started `);
  console.log(` Port: ${PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Allowed Origin: ${clientUrl}`);
  console.log(`===============================================`);
});

module.exports = { app, server };
