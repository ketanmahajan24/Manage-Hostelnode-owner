/* ============================================================
   models/rentReminder.js  —  Property Operations Phase 9

   One line per rent reminder sent to a tenant (automatic or sent by
   the owner from Dues). key makes each automatic reminder happen once:
   "<tenant>:<step>:<due date>", step = before | due | after.
============================================================ */
const mongoose = require("mongoose");

const rentReminderSchema = new mongoose.Schema({
  key:    { type: String, required: true },
  owner:  { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true },
  hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" },
  member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
  step:   { type: String, required: true },           // before | due | after | manual
  dueOn:  { type: Date },
  amount: { type: Number, default: 0 },
  wa:     { _id: false, sent: { type: Boolean, default: false }, why: { type: String, default: "" } },
  email:  { _id: false, sent: { type: Boolean, default: false }, why: { type: String, default: "" } },
  by:     { type: String, default: "auto" },          // "auto" or the owner's name
  at:     { type: Date, default: Date.now },
});
rentReminderSchema.index({ key: 1 });
rentReminderSchema.index({ member: 1, at: -1 });

module.exports = mongoose.models.RentReminder || mongoose.model("RentReminder", rentReminderSchema);
