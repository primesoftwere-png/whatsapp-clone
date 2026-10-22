const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema(
  {
    blocker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Blocker user ID is required']
    },
    blocked: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Blocked user ID is required']
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocker: 1 });
blockSchema.index({ blocked: 1 });

const Block = mongoose.model('Block', blockSchema);
module.exports = Block;
