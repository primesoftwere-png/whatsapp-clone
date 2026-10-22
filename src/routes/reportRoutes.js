const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { adminOnly } = require('../middleware/auth');

// Any authenticated user can submit a report
router.post('/', reportController.createReport);

// Admin-only endpoints for reviewing reports
router.get('/', adminOnly, reportController.getReports);
router.patch('/:id', adminOnly, reportController.updateReport);

module.exports = router;
