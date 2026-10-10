/* ============================================================
   models/reminderSettings.js  —  Property Operations Phase 9

   One per owner: automatic rent reminders to tenants (WhatsApp from
   HostelNode's number, and email). An owner with no settings yet has
   the defaults below (on; 3 days before, on the due day, 3 days after).
============================================================ */
const mongoose = require("mongoose");

const reminderSettingsSchema = new mongoose.Schema({
  owner:      { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true, unique: true },
  on:         { type: Boolean, default: true },
  before:     { type: Number, default: 3 },            // days before the due day (0 = don't send)
  onDay:      { type: Boolean, default: true },        // on the due day
  after:      { type: Number, default: 3 },            // days after the due day, if still unpaid (0 = don't send)
  offHostels: [{ type: mongoose.Schema.Types.ObjectId, ref: "Hostel" }],   // properties with reminders switched off
}, { timestamps: true });

module.exports = mongoose.models.ReminderSettings || mongoose.model("ReminderSettings", reminderSettingsSchema);
