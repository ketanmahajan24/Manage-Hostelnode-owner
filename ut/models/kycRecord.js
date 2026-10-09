/* ============================================================
   models/kycRecord.js  —  Property Operations Phase 4 (DigiLocker KYC)
   SHARED: identical in the owner dashboard and hostelnode.com.

   One record per mobile number (the person's HostelNode identity: the
   same number is the student account, the lead and the tenant).
   Stored from DigiLocker (through Cashfree): verified name, date of
   birth, gender, state and the LAST 4 Aadhaar digits only.
   Never stored: the full Aadhaar number, the photo, the Aadhaar file.
============================================================ */
const mongoose = require("mongoose");

const kycRecordSchema = new mongoose.Schema({
  phone:  { type: String, required: true, unique: true },     // 10 digits
  status: { type: String, enum: ["none", "pending", "verified", "failed"], default: "none" },
  // verified details (from Aadhaar, through DigiLocker)
  name:   { type: String, default: "" },
  dob:    { type: Date, default: null },
  dobYearOnly: { type: Boolean, default: false },   // DigiLocker gave only the year of birth
  gender: { type: String, default: "" },          // Male, Female, Other
  state:  { type: String, default: "" },
  last4:  { type: String, default: "" },
  verifiedAt:     { type: Date, default: null },
  verificationId: { type: String, default: "" },  // ours, sent to Cashfree
  referenceId:    { type: String, default: "" },  // Cashfree's
  provider:       { type: String, default: "" },  // "cashfree-digilocker"
  via:            { type: String, default: "" },  // "student" (on hostelnode.com) or "owner" (on the owner's phone)
  student:        { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
  byOwner:        { type: mongoose.Schema.Types.ObjectId, ref: "Owner", default: null },
  mobileMatch:    { type: Boolean, default: null },   // the mobile linked to the Aadhaar ends like this number
  // Who this Aadhaar is (a one-way fingerprint of name, birth date and last 4), so a verified number
  // is never taken over by a different person's Aadhaar.
  identity:       { type: String, default: "" },
  // Owners the person agreed to share the verified details with (verified through their link,
  // tapped "Share", or verified on that owner's phone in person). Only they see name / birth date.
  sharedWith:     [{ _id: false, owner: { type: mongoose.Schema.Types.ObjectId, ref: "Owner" }, hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" }, at: Date }],
  // attempts that are not finished yet
  pendingSince:   { type: Date, default: null },
  lastError:      { type: String, default: "" },
  // owners who asked this person to verify (so they may see the result)
  requests:       [{ _id: false, owner: { type: mongoose.Schema.Types.ObjectId, ref: "Owner" }, at: Date }],
}, { timestamps: true });

module.exports = mongoose.models.KycRecord || mongoose.model("KycRecord", kycRecordSchema);
