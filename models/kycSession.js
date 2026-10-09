/* ============================================================
   models/kycSession.js  —  Property Operations Phase 4 (DigiLocker KYC)
   SHARED: identical in the owner dashboard and hostelnode.com.
   One DigiLocker attempt (a link from Cashfree, valid 10 minutes).
   _id is our verification_id.
============================================================ */
const mongoose = require("mongoose");

const kycSessionSchema = new mongoose.Schema({
  _id:         { type: String },
  phone:       { type: String, required: true },
  via:         { type: String, default: "student" },     // student | owner
  student:     { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: "Owner", default: null },
  hostel:      { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", default: null },
  referenceId: { type: String, default: "" },
  status:      { type: String, default: "PENDING" },     // PENDING, DONE, EXPIRED, CONSENT_DENIED, FAILED
  createdAt:   { type: Date, default: Date.now },
  doneAt:      { type: Date, default: null },
});

module.exports = mongoose.models.KycSession || mongoose.model("KycSession", kycSessionSchema);
