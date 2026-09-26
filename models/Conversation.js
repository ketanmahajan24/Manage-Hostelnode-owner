const mongoose = require("mongoose");

/* ============================================================
   CONVERSATION SCHEMA — HostelNode
   ONE universal conversation model shared by PG/Hostel enquiries
   and Flatmate connections (per the "single Messages system"
   requirement — no separate Flatmate-only chat).

   `listing` uses a dynamic ref (refPath) so it can point at either
   the existing `Listing` (PG/Hostel) or the new `FlatmateListing`
   model depending on `listingModel`, without needing two separate
   conversation collections.
============================================================ */

const conversationSchema = new mongoose.Schema({

  type: {
    type: String,
    enum: ["PG_INQUIRY", "FLATMATE_CONNECTION"],
    required: true,
    index: true,
  },

  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Student",
    required: true,
  }],

  // NEW (PG/Hostel chat) — only set when type === "PG_INQUIRY". The
  // Student side of a PG conversation still lives in `participants`
  // (as a single entry), exactly like before, so every existing
  // Flatmate populate()/counterpart lookup keeps working unchanged.
  // This field is how the Owner side attaches without redefining what
  // `participants` means for FLATMATE_CONNECTION conversations.
  ownerParticipant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Owner",
    default: null,
  },

  listing: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "listingModel",
    default: null,
  },
  listingModel: {
    type: String,
    enum: ["Listing", "FlatmateListing"],
    default: null,
  },

  // Only set for type === "FLATMATE_CONNECTION"
  connection: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "FlatmateConnection",
    default: null,
  },

  status: {
    type: String,
    enum: ["active", "closed"],
    default: "active",
    index: true,
  },

  lastMessage:   { type: String, default: "" },
  lastMessageAt: { type: Date, default: null },

  // Map<studentId (string), unreadCount>
  unreadCounts: {
    type: Map,
    of: Number,
    default: {},
  },

  // Map<studentId (string), Date> (Phase 10) — dedupe guard for the
  // "unread message reminder" cron: records when a reminder was last
  // sent to that participant so it doesn't re-fire every cron run
  // while messages stay unread. Cleared for a participant the moment
  // their unread count for this conversation returns to 0.
  unreadReminderSentAt: {
    type: Map,
    of: Date,
    default: {},
  },

}, { timestamps: true });

conversationSchema.index({ participants: 1, updatedAt: -1 });

module.exports = mongoose.model("Conversation", conversationSchema);
