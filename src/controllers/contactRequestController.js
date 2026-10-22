const ContactRequest = require('../models/ContactRequest');
const Conversation = require('../models/Conversation');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Block = require('../models/Block');
const ApiError = require('../utils/ApiError');
const { getIO } = require('../config/socket');
const { isValidObjectId } = require('../utils/helpers');

/**
 * @desc    Send a contact request
 * @route   POST /api/contact-requests
 * @access  Private
 */
const sendRequest = async (req, res, next) => {
  try {
    const toUserId = req.body.toUserId || req.body.recipientId;
    const message = req.body.message;

    if (!toUserId || !isValidObjectId(toUserId)) {
      return next(ApiError.badRequest('Valid recipient user ID (toUserId) is required'));
    }

    if (toUserId.toString() === req.user._id.toString()) {
      return next(ApiError.badRequest('Cannot send a contact request to yourself'));
    }

    const recipient = await User.findById(toUserId);
    if (!recipient) {
      return next(ApiError.notFound('Recipient user not found'));
    }

    // Check privacy settings
    if (recipient.privacySettings?.allowContactRequests === 'nobody') {
      return next(ApiError.forbidden('This user does not accept contact requests'));
    }

    // Check block status
    const isBlocked = await Block.findOne({
      $or: [
        { blocker: req.user._id, blocked: toUserId },
        { blocker: toUserId, blocked: req.user._id }
      ]
    });
    if (isBlocked) {
      return next(ApiError.forbidden('Cannot send request due to block settings'));
    }

    // Check existing request
    const existing = await ContactRequest.findOne({
      $or: [
        { from: req.user._id, to: toUserId },
        { from: toUserId, to: req.user._id }
      ]
    });

    if (existing) {
      if (existing.status === 'pending') {
        return next(ApiError.conflict('A pending contact request already exists between you and this user'));
      }
      if (existing.status === 'accepted') {
        return next(ApiError.conflict('You are already contacts with this user'));
      }
      // If declined or cancelled, update existing request to pending
      existing.from = req.user._id;
      existing.to = toUserId;
      existing.status = 'pending';
      existing.message = message || '';
      await existing.save();

      // Create notification
      const notification = await Notification.create({
        user: toUserId,
        type: 'contact_request',
        title: 'New Contact Request',
        message: `${req.user.name} sent you a contact request`,
        relatedUser: req.user._id
      });

      const io = getIO();
      if (io) {
        io.to(toUserId.toString()).emit('notification:new', notification);
        io.to(toUserId.toString()).emit('contact_request:received', existing);
      }

      return res.status(200).json({
        success: true,
        message: 'Contact request sent',
        request: existing
      });
    }

    const newRequest = await ContactRequest.create({
      from: req.user._id,
      to: toUserId,
      status: 'pending',
      message: message || ''
    });

    // Create notification
    const notification = await Notification.create({
      user: toUserId,
      type: 'contact_request',
      title: 'New Contact Request',
      message: `${req.user.name} sent you a contact request`,
      relatedUser: req.user._id
    });

    const populatedRequest = await ContactRequest.findById(newRequest._id)
      .populate('from', 'name username avatar')
      .populate('to', 'name username avatar');

    const io = getIO();
    if (io) {
      io.to(toUserId.toString()).emit('notification:new', notification);
      io.to(toUserId.toString()).emit('contact_request:received', populatedRequest);
    }

    res.status(201).json({
      success: true,
      message: 'Contact request sent successfully',
      request: populatedRequest
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get incoming and outgoing contact requests
 * @route   GET /api/contact-requests
 * @access  Private
 */
const getRequests = async (req, res, next) => {
  try {
    const incoming = await ContactRequest.find({
      to: req.user._id,
      status: 'pending'
    })
      .populate('from', 'name username avatar bio isOnline lastSeen')
      .sort({ createdAt: -1 });

    const outgoing = await ContactRequest.find({
      from: req.user._id,
      status: 'pending'
    })
      .populate('to', 'name username avatar bio isOnline lastSeen')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      incoming,
      outgoing
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Accept contact request
 * @route   PATCH /api/contact-requests/:id/accept
 * @access  Private
 */
const acceptRequest = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid request ID'));
    }

    const request = await ContactRequest.findById(id);
    if (!request) {
      return next(ApiError.notFound('Contact request not found'));
    }

    if (request.to.toString() !== req.user._id.toString()) {
      return next(ApiError.forbidden('Only the recipient can accept this contact request'));
    }

    if (request.status === 'accepted') {
      return next(ApiError.badRequest('Contact request has already been accepted'));
    }

    request.status = 'accepted';
    await request.save();

    // Ensure private conversation exists between the two users
    let conversation = await Conversation.findOne({
      type: 'private',
      'participants.user': { $all: [request.from, request.to] }
    });

    if (!conversation) {
      conversation = await Conversation.create({
        type: 'private',
        participants: [
          { user: request.from, role: 'owner', joinedAt: new Date() },
          { user: request.to, role: 'member', joinedAt: new Date() }
        ],
        createdBy: req.user._id
      });
    }

    // Create notification for original requester
    const notification = await Notification.create({
      user: request.from,
      type: 'contact_accepted',
      title: 'Contact Request Accepted',
      message: `${req.user.name} accepted your contact request`,
      relatedUser: req.user._id,
      relatedConversation: conversation._id
    });

    const populatedRequest = await ContactRequest.findById(id)
      .populate('from', 'name username avatar isOnline lastSeen')
      .populate('to', 'name username avatar isOnline lastSeen');

    const io = getIO();
    if (io) {
      io.to(request.from.toString()).emit('notification:new', notification);
      io.to(request.from.toString()).emit('contact_request:accepted', {
        request: populatedRequest,
        conversationId: conversation._id
      });
    }

    res.status(200).json({
      success: true,
      message: 'Contact request accepted',
      request: populatedRequest,
      conversationId: conversation._id
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Decline contact request
 * @route   PATCH /api/contact-requests/:id/decline
 * @access  Private
 */
const declineRequest = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid request ID'));
    }

    const request = await ContactRequest.findById(id);
    if (!request) {
      return next(ApiError.notFound('Contact request not found'));
    }

    if (request.to.toString() !== req.user._id.toString()) {
      return next(ApiError.forbidden('Only recipient can decline this request'));
    }

    request.status = 'declined';
    await request.save();

    res.status(200).json({
      success: true,
      message: 'Contact request declined',
      request
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Cancel outgoing contact request
 * @route   DELETE /api/contact-requests/:id
 * @access  Private
 */
const cancelRequest = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return next(ApiError.badRequest('Invalid request ID'));
    }

    const request = await ContactRequest.findById(id);
    if (!request) {
      return next(ApiError.notFound('Contact request not found'));
    }

    if (request.from.toString() !== req.user._id.toString()) {
      return next(ApiError.forbidden('Only sender can cancel this request'));
    }

    request.status = 'cancelled';
    await request.save();

    res.status(200).json({
      success: true,
      message: 'Contact request cancelled'
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  sendRequest,
  getRequests,
  acceptRequest,
  declineRequest,
  cancelRequest
};
