const express = require('express');
const router = express.Router();
const blockController = require('../controllers/blockController');

router.get('/', blockController.getBlockedUsers);
router.post('/', blockController.blockUser);
router.delete('/:userId', blockController.unblockUser);

module.exports = router;
