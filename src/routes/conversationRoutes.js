const express = require('express');
const router = express.Router();
const conversationController = require('../controllers/conversationController');

router.get('/', conversationController.getConversations);
router.post('/', conversationController.createConversation);
router.get('/:id', conversationController.getConversation);
router.patch('/:id', conversationController.updateConversation);
router.patch('/:id/archive', conversationController.archiveConversation);
router.patch('/:id/mute', conversationController.muteConversation);
router.patch('/:id/pin', conversationController.pinConversation);

module.exports = router;
