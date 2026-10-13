/* ============================================================
   models/hnEmailLog.js  —  Admin Console Phase 1 (email log)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.
   One row per email sent through utils/sendMail.js. Kept 365 days.
============================================================ */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const hnEmailLogSchema = new Schema({
  at:       { type: Date, default: Date.now },
  site:     { type: String, default: "" },
  purpose:  { type: String, default: "other" },  // otp | password | welcome | login_alert | listing | plan_receipt | plan_reminder | rent_reminder | admin_alert | other
  toMasked: { type: String, default: "" },       // "ke•••@gmail.com"
  toHash:   { type: String, default: "" },       // keyed hash of the lower-case address (utils/hnPii.js)
  subject:  { type: String, default: "" },
  ok:       { type: Boolean, default: false },
  error:    { type: String, default: "" },
}, { versionKey: false });

hnEmailLogSchema.index({ at: -1 });
hnEmailLogSchema.index({ toHash: 1, at: -1 });
hnEmailLogSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600, name: "ttl_365d" });

module.exports = mongoose.models.HnEmailLog || mongoose.model("HnEmailLog", hnEmailLogSchema, "hn_email_log");
