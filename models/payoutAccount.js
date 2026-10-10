/* ============================================================
   models/payoutAccount.js  —  Property Operations Phase 6: owner bank payouts
   SHARED: identical in the owner dashboard and hostelnode.com.

   One per owner: their Razorpay Route linked account (where online rent
   is paid out). The bank account number and PAN are sent to Razorpay
   and never kept here — only the last 4 digits and the IFSC.

   status (what HostelNode shows):
     draft            not submitted yet (or the first step failed)
     under_review     Razorpay is checking (requested / under_review)
     active           activated: online rent can be paid out
     needs_attention  needs_clarification: see requirements
     suspended        Razorpay suspended it
   hold: paused by HostelNode admin (online rent is held before payout).
============================================================ */
const mongoose = require("mongoose");

const payoutAccountSchema = new mongoose.Schema({
  owner:          { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true, unique: true },
  mode:           { type: String, default: "" },        // "test" or "live": the Razorpay keys it was made with
  accountId:      { type: String, default: "" },        // acc_…
  stakeholderId:  { type: String, default: "" },        // sth_…
  productId:      { type: String, default: "" },        // acc_prd_…
  status:         { type: String, enum: ["draft", "under_review", "active", "needs_attention", "suspended"], default: "draft" },
  razorpayStatus: { type: String, default: "" },        // activation_status as Razorpay said it
  requirements:   [{ _id: false, field: String, reason: String }],

  businessType:   { type: String, default: "" },        // individual | proprietorship | partnership | private_limited | llp
  legalName:      { type: String, default: "" },
  contactName:    { type: String, default: "" },
  email:          { type: String, default: "" },
  phone:          { type: String, default: "" },
  panLast4:       { type: String, default: "" },
  street:         { type: String, default: "" },
  city:           { type: String, default: "" },
  pin:            { type: String, default: "" },
  state:          { type: String, default: "" },

  bankLast4:      { type: String, default: "" },
  ifsc:           { type: String, default: "" },
  bankName:       { type: String, default: "" },
  bankBranch:     { type: String, default: "" },
  beneficiaryName:{ type: String, default: "" },

  submittedAt:    { type: Date, default: null },
  activatedAt:    { type: Date, default: null },
  lastCheckedAt:  { type: Date, default: null },
  lastError:      { type: String, default: "" },

  // HostelNode admin: pause payouts (online rent is held before reaching the owner's bank).
  hold: {
    on:     { type: Boolean, default: false },
    reason: { type: String, default: "" },
    by:     { type: String, default: "" },
    at:     { type: Date, default: null },
  },
  // HostelNode admin: this owner's own commission (otherwise the default from payoutSettings).
  commission: {
    own:   { type: Boolean, default: false },
    type:  { type: String, enum: ["percent", "fixed"], default: "percent" },
    value: { type: Number, default: 0 },
  },
  history: [{ _id: false, at: { type: Date, default: Date.now }, text: String, by: String }],
}, { timestamps: true });

module.exports = mongoose.models.PayoutAccount || mongoose.model("PayoutAccount", payoutAccountSchema);
