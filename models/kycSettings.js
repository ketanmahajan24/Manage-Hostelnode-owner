/* ============================================================
   models/kycSettings.js  —  Property Operations Phase 4 (DigiLocker KYC)
   SHARED: identical in the owner dashboard and hostelnode.com.
   The two switches on hostelnode.com/admin/kyc (one document, key "main").
============================================================ */
const mongoose = require("mongoose");

const kycSettingsSchema = new mongoose.Schema({
  key:                  { type: String, default: "main", unique: true },
  studentsCanVerify:    { type: Boolean, default: true },
  requiredForAdmission: { type: Boolean, default: false },
  updatedBy:            { type: String, default: "" },
}, { timestamps: true });

module.exports = mongoose.models.KycSettings || mongoose.model("KycSettings", kycSettingsSchema);
