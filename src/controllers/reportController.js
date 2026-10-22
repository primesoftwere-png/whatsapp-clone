const Report = require('../models/Report');
const User = require('../models/User');
const Message = require('../models/Message');
const ApiError = require('../utils/ApiError');
const { parsePagination, isValidObjectId } = require('../utils/helpers');

/**
 * @desc    Submit an abuse report
 * @route   POST /api/reports
 * @access  Private
 */
const createReport = async (req, res, next) => {
  try {
    const { reportedUser, reportedMessage, reason, description } = req.body;

    if (!reason || !['spam', 'harassment', 'inappropriate', 'other'].includes(reason)) {
      return next(ApiError.badRequest('Valid report reason is required (spam, harassment, inappropriate, other)'));
    }

    if (!reportedUser && !reportedMessage) {
      return next(ApiError.badRequest('At least one of reportedUser or reportedMessage is required'));
    }

    if (reportedUser && !isValidObjectId(reportedUser)) {
      return next(ApiError.badRequest('Invalid reportedUser ID'));
    }

    if (reportedMessage && !isValidObjectId(reportedMessage)) {
      return next(ApiError.badRequest('Invalid reportedMessage ID'));
    }

    const report = await Report.create({
      reporter: req.user._id,
      reportedUser: reportedUser || null,
      reportedMessage: reportedMessage || null,
      reason,
      description: description ? description.trim() : ''
    });

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully. Our team will review it shortly.',
      report
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get abuse reports (Admin only)
 * @route   GET /api/reports
 * @access  Private (Admin)
 */
const getReports = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, 20);
    const filter = {};

    if (req.query.status) {
      filter.status = req.query.status;
    }

    if (req.query.reason) {
      filter.reason = req.query.reason;
    }

    const total = await Report.countDocuments(filter);

    const reports = await Report.find(filter)
      .populate('reporter', 'name username email')
      .populate('reportedUser', 'name username email avatar')
      .populate('reportedMessage', 'content sender type attachments createdAt')
      .populate('reviewedBy', 'name username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      reports,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Review/update report status (Admin only)
 * @route   PATCH /api/reports/:id
 * @access  Private (Admin)
 */
const updateReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid report ID'));
    }

    if (!status || !['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
      return next(ApiError.badRequest('Valid status is required (pending, reviewed, resolved, dismissed)'));
    }

    const report = await Report.findById(id);
    if (!report) {
      return next(ApiError.notFound('Report not found'));
    }

    report.status = status;
    report.reviewedBy = req.user._id;
    if (reviewNotes !== undefined) {
      report.reviewNotes = reviewNotes.trim();
    }

    await report.save();

    const updated = await Report.findById(id)
      .populate('reporter', 'name username email')
      .populate('reportedUser', 'name username email')
      .populate('reviewedBy', 'name username');

    res.status(200).json({
      success: true,
      message: 'Report updated successfully',
      report: updated
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createReport,
  getReports,
  updateReport
};
