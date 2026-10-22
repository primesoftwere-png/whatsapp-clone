const express = require('express');
const router = express.Router();
const contactRequestController = require('../controllers/contactRequestController');

router.post('/', contactRequestController.sendRequest);
router.get('/', contactRequestController.getRequests);
router.patch('/:id/accept', contactRequestController.acceptRequest);
router.patch('/:id/decline', contactRequestController.declineRequest);
router.delete('/:id', contactRequestController.cancelRequest);

module.exports = router;
