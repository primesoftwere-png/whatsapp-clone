const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { messageLimiter } = require('../middleware/rateLimiter');

// Conversation message retrieval and sending
router.get('/conversations/:conversationId/messages', messageController.getMessages);
router.post('/conversations/:conversationId/messages', messageLimiter, messageController.sendMessage);
router.post('/conversations/:conversationId/read', messageController.markConversationAsRead);

// Message item operations
router.patch('/:id', messageLimiter, messageController.editMessage);
router.delete('/:id', messageController.deleteMessage);
router.post('/:id/read', messageController.markAsRead);

module.exports = router;
