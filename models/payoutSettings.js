/* ============================================================
   models/payoutSettings.js  —  Property Operations Phase 6
   SHARED: identical in the owner dashboard and hostelnode.com.

   Fees on online rent, set only in the hostelnode.com admin:
   • HostelNode commission: a percentage or a fixed ₹ per payment (can be 0).
     An owner can have their own rate (payoutAccount.commission).
   • Payment gateway fee: a percentage or a fixed ₹, paid by the tenant
     (added to what they pay) or by the owner (taken from the payout).
============================================================ */
const mongoose = require("mongoose");

const payoutSettingsSchema = new mongoose.Schema({
  key:             { type: String, default: "main", unique: true },
  commissionType:  { type: String, enum: ["percent", "fixed"], default: "percent" },
  commissionValue: { type: Number, default: 0 },
  feeType:         { type: String, enum: ["percent", "fixed"], default: "percent" },
  feeValue:        { type: Number, default: 2 },
  feePaidBy:       { type: String, enum: ["tenant", "owner"], default: "owner" },
  updatedBy:       { type: String, default: "" },
}, { timestamps: true });

/** The settings (defaults when none are saved yet). */
payoutSettingsSchema.statics.read = async function () {
  const s = await this.findOne({ key: "main" }).lean();
  return Object.assign({ commissionType: "percent", commissionValue: 0, feeType: "percent", feeValue: 2, feePaidBy: "owner" }, s || {});
};

module.exports = mongoose.models.PayoutSettings || mongoose.model("PayoutSettings", payoutSettingsSchema);
