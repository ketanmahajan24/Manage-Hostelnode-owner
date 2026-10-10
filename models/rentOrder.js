/* ============================================================
   models/rentOrder.js  —  Property Operations Phase 7: rent paid online
   SHARED: identical in the owner dashboard and hostelnode.com.

   One per Razorpay order a tenant starts from My PG (hostelnode.com).
   Every amount is worked out on the server when the order is made and
   kept here; the ledger entry is made once, when Razorpay confirms it
   (the tenant's browser, or the webhook if the page was closed).
============================================================ */
const mongoose = require("mongoose");

const rentOrderSchema = new mongoose.Schema({
  owner:           { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true },
  hostel:          { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" },
  member:          { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
  student:         { type: mongoose.Schema.Types.ObjectId },     // the hostelnode.com account that paid
  // Money (₹): amount is credited to rent; total is what the tenant pays (amount + fee when the tenant pays it).
  amount:          { type: Number, required: true },
  fee:             { type: Number, default: 0 },
  commission:      { type: Number, default: 0 },
  feePaidBy:       { type: String, default: "owner" },
  total:           { type: Number, required: true },
  amountPaise:     { type: Number, required: true },              // total in paise (what Razorpay charges)
  toOwnerPaise:    { type: Number, required: true },              // the Route transfer to the owner's bank
  accountId:       { type: String, default: "" },                 // acc_…
  onHold:          { type: Boolean, default: false },             // payouts held by HostelNode admin when it was made
  dueAt:           { type: Number, default: 0 },                  // what was due when it was made (₹)
  receipt:         { type: String, default: "" },                 // our reference sent to Razorpay
  razorpayOrderId: { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, default: "" },
  method:          { type: String, default: "" },
  status:          { type: String, enum: ["created", "paid", "failed"], default: "created" },
  failureReason:   { type: String, default: "" },
  payment:         { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },   // the ledger entry (once recorded)
  paidAt:          { type: Date },
  via:             { type: String, default: "" },                 // "checkout" | "webhook" | "check"
  // Another payment on this order after it was paid (two tabs): not counted as rent; HostelNode refunds it.
  extraPayments:   [{ type: String }],
}, { timestamps: true });

rentOrderSchema.index({ member: 1, createdAt: -1 });

module.exports = mongoose.models.RentOrder || mongoose.model("RentOrder", rentOrderSchema);
