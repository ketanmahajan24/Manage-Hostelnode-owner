const mongoose = require("mongoose");

/* ============================================================
   NOTIFICATION SCHEMA — HostelNode
   Kept separate from Messages (per spec: Notifications = alerts
   that something happened, Messages = source of truth for actual
   communication). Wired up fully in Phase 7 — this model exists
   from Phase 1 onward so Phase 4/5's connection actions can start
   writing to it immediately.
============================================================ */

const notificationSchema = new mongoose.Schema({

  // CHANGED (PG/Hostel chat, Phase 5) — a notification's recipient can
  // now be a Student or an Owner, so `user` is a dynamic ref keyed off
  // userModel below, same additive pattern already used for
  // Message.sender/senderModel in Phase 1. Every notification created
  // before this field existed is simply missing userModel, and
  // userModel's default of "Student" makes that read back exactly as
  // before — no data migration, and every existing Student-side query
  // (Notification.find({ user: studentId }), the unread bell, etc.) is
  // completely unaffected because none of them look at userModel at
  // all today.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "userModel",
    required: true,
    index: true,
  },

  // NEW (Phase 5) — see comment above. Absent on every pre-existing
  // document, which is read the same as "Student".
  userModel: {
    type: String,
    enum: ["Student", "Owner"],
    default: "Student",
  },

  type: {
    type: String,
    enum: [
      "FLATMATE_CONNECTION_REQUEST",
      "FLATMATE_REQUEST_ACCEPTED",
      "FLATMATE_REQUEST_DECLINED",
      "FLATMATE_REQUEST_CANCELLED",
      "FLATMATE_CONNECTION_REMOVED",
      "FLATMATE_NEW_MESSAGE",
      "LISTING_CLOSED",
      "FLATMATE_LISTING_PAUSED",
      "FLATMATE_REPORT_RECEIVED",
      "FLATMATE_LISTING_PUBLISHED",
      // Phase 10 — reminder/engagement notifications
      "FLATMATE_REQUEST_PENDING_REMINDER",
      "FLATMATE_MESSAGE_UNREAD_REMINDER",
      "FLATMATE_NEW_MATCHING_LISTING",
      "FLATMATE_LISTING_EXPIRING_SOON",
      "FLATMATE_LISTING_EXPIRED",
      "FLATMATE_LISTING_VIEW_MILESTONE",
      "FLATMATE_LISTING_REACTIVATE_REMINDER",
      // NEW (PG/Hostel chat, Phase 5) — a student messages a PG/Hostel
      // owner. Kept as its own distinct type rather than reusing
      // FLATMATE_NEW_MESSAGE, matching this schema's existing
      // convention of one enum value per distinct event (every other
      // Flatmate event already gets its own), and keeping PG/Hostel
      // activity separately queryable from Flatmate activity.
      "PG_NEW_MESSAGE",
      // Property Operations Phase 8 — a student booked a bed (and reminders to answer it).
      "PG_BOOKING",
    ],
    required: true,
  },

  title: { type: String, required: true },
  body:  { type: String, default: "" },
  link:  { type: String, default: null }, // where the "Open" action navigates

  relatedConnection:   { type: mongoose.Schema.Types.ObjectId, ref: "FlatmateConnection", default: null },
  relatedConversation:  { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", default: null },
  relatedListing:       { type: mongoose.Schema.Types.ObjectId, ref: "FlatmateListing", default: null },

  // Best-effort duplicate guard for the centralized notification
  // service (utils/flatmateNotifications.js) — see that file for how
  // it's used. Not unique-indexed on purpose (see that file's header).
  dedupeKey: { type: String, default: null, index: true },

  isRead: { type: Boolean, default: false, index: true },
  readAt: { type: Date, default: null },

}, { timestamps: true });

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
