const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true
    },
    type: {
      type: String,
      enum: ['image', 'video'],
      required: true,
      default: 'image'
    },
    mediaUrl: {
      type: String,
      required: [true, 'Media URL is required']
    },
    caption: {
      type: String,
      default: '',
      trim: true,
      maxlength: [500, 'Caption cannot exceed 500 characters']
    },
    likes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ],
    viewers: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        viewedAt: {
          type: Date,
          default: Date.now
        }
      }
    ],
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
      index: true
    }
  },
  {
    timestamps: true
  }
);

statusSchema.index({ expiresAt: 1 });
statusSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Status', statusSchema);
