/* ============================================================
   models/booking.js  —  Property Operations Phase 8: booking from listings
   SHARED: identical in the owner dashboard and hostelnode.com.

   A student books a bed from a listing on hostelnode.com and pays a
   booking amount online (Razorpay, with the owner's share held by Route
   until move-in). The owner accepts with an exact bed, or declines.

   status:
     pending_payment  the student started paying (not shown anywhere)
     requested        paid; waiting for the owner (48 h; refunded after 72 h)
     accepted         the owner picked a bed (shown as Booked on the bed map)
     moved_in         admitted; the booking amount was credited
     declined         by the owner (full refund)
     cancelled        by the student, or by the owner after accepting (refund by the rule)
     expired          no answer within 72 hours (full refund)
============================================================ */
const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  bookingNo:     { type: String, default: "" },                    // BK-2026-0031 (once paid)
  owner:         { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true },
  hostel:        { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", required: true },
  listing:       { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
  student:       { type: mongoose.Schema.Types.ObjectId, required: true },
  studentName:   { type: String, default: "" },
  studentPhone:  { type: String, default: "" },
  property:      { type: String, default: "" },                    // the listing/property name when booked
  roomType:      { type: String, default: "" },                    // "Double sharing" (from the listing)
  typeIndex:     { type: Number, default: 0 },
  rent:          { type: Number, default: 0 },                     // the listing's price for that type (₹ a month)
  deposit:       { type: Number, default: 0 },                     // the listing's deposit for that type
  moveIn:        { type: Date, required: true },
  kycName:       { type: String, default: "" },                    // verified name when booked (empty = not verified)

  // Money (₹). amount counts towards rent or deposit; total = amount + fee when the student pays the fee.
  amount:        { type: Number, required: true },
  fee:           { type: Number, default: 0 },
  commission:    { type: Number, default: 0 },
  feePaidBy:     { type: String, default: "owner" },
  total:         { type: Number, required: true },
  amountPaise:   { type: Number, required: true },
  toOwnerPaise:  { type: Number, required: true },
  accountId:     { type: String, default: "" },
  countsTowards: { type: String, default: "rent" },                // "rent" | "deposit"
  rule:          { _id: false, after: { type: String, default: "full" }, days: { type: Number, default: 0 } },   // refund if cancelled after acceptance

  razorpayOrderId:   { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, default: "" },
  method:        { type: String, default: "" },
  paidAt:        { type: Date },

  status:        { type: String, default: "pending_payment" },
  bed:           { _id: false, room: { type: mongoose.Schema.Types.ObjectId }, roomNumber: String, label: String },
  acceptedAt:    { type: Date },
  decidedBy:     { type: String, default: "" },
  closedAt:      { type: Date },
  reason:        { type: String, default: "" },                    // why it was declined or cancelled
  cancelledBy:   { type: String, default: "" },                    // "student" | "owner" | "system"
  reminders:     { type: Number, default: 0 },                     // reminders sent to the owner (24 h, 48 h)

  // Refund (paise). target: to the student; reverse: taken back from the owner's share.
  refund: {
    _id: false,
    target:  { type: Number, default: 0 },
    reverse: { type: Number, default: 0 },
    status:  { type: String, default: "" },                        // "" | "pending" | "done" | "failed"
    tries:   { type: Number, default: 0 },
    error:   { type: String, default: "" },
    at:      { type: Date },
  },
  // The owner's share (Route transfer): held until move-in (or kept after a cancellation).
  payout: {
    _id: false,
    transferId: { type: String, default: "" },
    status:     { type: String, default: "" },                     // on_hold | pending | settled | failed | reversed
    settledAt:  { type: Date },
    checkedAt:  { type: Date },
  },
  member:        { type: mongoose.Schema.Types.ObjectId, ref: "Member" },    // after Admit
  payment:       { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },   // the ledger entry (counts towards rent)
  movedInAt:     { type: Date },
  history:       [{ _id: false, at: { type: Date, default: Date.now }, text: String, by: String }],
  // Another payment on this booking after it was paid (two tabs): not counted; HostelNode refunds it (admin page).
  extraPayments: [{ type: String }],
  checkedAt:     { type: Date },                                   // last move-in check by the 15-minute job
}, { timestamps: true });

bookingSchema.index({ owner: 1, status: 1, createdAt: -1 });
bookingSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.models.Booking || mongoose.model("Booking", bookingSchema);
