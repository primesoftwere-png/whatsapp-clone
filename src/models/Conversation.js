const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: ['member', 'admin', 'owner'],
      default: 'member'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['private', 'group'],
      required: [true, 'Conversation type is required']
    },
    name: {
      type: String,
      trim: true,
      default: ''
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500
    },
    avatar: {
      type: String,
      default: ''
    },
    participants: [participantSchema],
    lastMessage: {
      content: { type: String, default: '' },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      timestamp: { type: Date, default: Date.now },
      type: { type: String, default: 'text' }
    },
    isPinned: {
      type: Boolean,
      default: false
    },
    isMuted: {
      type: Boolean,
      default: false
    },
    isArchived: {
      type: Boolean,
      default: false
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: true
  }
);

conversationSchema.index({ 'participants.user': 1 });
conversationSchema.index({ updatedAt: -1 });
conversationSchema.index({ 'participants.user': 1, isPinned: -1, updatedAt: -1 });
conversationSchema.index({ type: 1, 'participants.user': 1 });

const Conversation = mongoose.model('Conversation', conversationSchema);
module.exports = Conversation;
