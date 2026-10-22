const mongoose = require('mongoose');

const contactRequestSchema = new mongoose.Schema(
  {
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Sender of contact request is required']
    },
    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recipient of contact request is required']
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'cancelled'],
      default: 'pending'
    },
    message: {
      type: String,
      default: '',
      maxlength: 250
    }
  },
  {
    timestamps: true
  }
);

contactRequestSchema.index({ from: 1, to: 1 }, { unique: true });
contactRequestSchema.index({ to: 1, status: 1 });
contactRequestSchema.index({ from: 1, status: 1 });

const ContactRequest = mongoose.model('ContactRequest', contactRequestSchema);
module.exports = ContactRequest;
