const mongoose = require("mongoose");

/* ============================================================
   MESSAGE SCHEMA — HostelNode
   Individual messages inside a Conversation. Access control lives
   in the route layer (verify sender is a participant, and for
   FLATMATE_CONNECTION conversations that the linked connection is
   still "accepted") — never trust the client on this.
============================================================ */

const messageSchema = new mongoose.Schema({

  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Conversation",
    required: true,
    index: true,
  },

  // CHANGED (PG/Hostel chat) — sender can now be a Student or an
  // Owner, so it's a dynamic ref keyed off senderModel below instead
  // of hardcoded to "Student".
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "senderModel",
    required: true,
  },

  // NEW — defaults to "Student" so every existing Flatmate message
  // (saved before this field existed, so it's simply absent on those
  // documents) is still read correctly: application code treats a
  // missing senderModel the same as "Student". No data migration
  // needed for existing messages.
  senderModel: {
    type: String,
    enum: ["Student", "Owner"],
    default: "Student",
  },

  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 2000,
  },

  attachments: [{ type: String }],

  // WhatsApp-style status, backend-driven only (never set from the client):
  // created  → "sent" (single grey tick)
  // deliveredAt set → the recipient's own client actually fetched this
  //   message (via poll or opening the chat) — "delivered" (double grey tick)
  // readAt set → the recipient had the chat open/focused when this was
  //   seen, or opened the conversation after it arrived — "read" (double
  //   blue tick). Read always implies delivered.
  deliveredAt: { type: Date, default: null },
  readAt: { type: Date, default: null },

}, { timestamps: true });

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
