const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
 user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User", // This references the User collection
        // required: true,
    },
  memberId: { 
    type: mongoose.Schema.Types.ObjectId,  
    ref: "Member", 
    required: true },

  roomId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Room", 
    // required: true 
  },
 
  roomFees:{ 
      type: Number, 
      required: true,
      default :0
      },
  totalFees:{ 
    type: Number, 
    required: true,
    default :0
    },
    advancedPaid: { 
      type: Number, 
      // required: true 
      default :0
      },
    amountPaid:{
    type: Number, 
    // required: true 
    default :0
    },
 
    dueAmount: { 
      type: Number, 
      // required: true 
      default :0
      },
  paymentDate: { 
    type: Date, 
    default: Date.now 
    },
  paymentMode: { 
    type: String, 
    // enum: ["Cash", "Card", "UPI", "Bank Transfer"], 
    // required: true 
    },
  payableDate: {
     type: Date 
    },
  // Property Operations Phase 1: "2026-10" on monthly rent charges added by
  // utils/monthlyRent.js, so a month is never charged twice. Empty on everything else.
  chargeMonth: {
    type: String
  },
  status: { 
    type: String, 
    enum: ["Paid", "Due","Advanced"], 
    default: "Due" 
    },

  // ── Property Operations Phase 5: rent ledger and cash payments ──
  // All optional: entries made before Phase 5 simply leave them empty, and the
  // ledger works out what they are (a charge has roomFees, a payment has amountPaid).
  // kind: "rent" | "extra" | "payment" | "deduction" | "refund" | "depositAdjust"
  kind:      { type: String, default: undefined },
  // The month an extra charge belongs to ("2026-10"). Rent charges use chargeMonth.
  month:     { type: String, default: undefined },
  // Extra charges: electricity, food, laundry, damage, lateFee, other.
  category:  { type: String, default: undefined },
  note:      { type: String, default: undefined },
  // Payments: UPI / bank reference, the receipt number, and who recorded it.
  reference: { type: String, default: undefined },
  receiptNo: { type: String, default: undefined },
  recordedBy: {
    _id: false,
    id:   { type: mongoose.Schema.Types.ObjectId },
    name: { type: String },
    role: { type: String }        // "owner" (wardens / managers later); "tenant" for online payments (Phase 7)
  },
  // What this payment paid for when it was recorded (shown on its receipt), and what was still due after it.
  appliedTo: [{ _id: false, label: String, amount: Number }],
  dueAfter:  { type: Number, default: undefined },
  // A wrong entry is cancelled, never deleted: it stays in the ledger, crossed out, with the reason.
  cancelledAt:  { type: Date, default: undefined },
  cancelReason: { type: String, default: undefined },
  cancelledBy: {
    _id: false,
    id:   { type: mongoose.Schema.Types.ObjectId },
    name: { type: String }
  },

  // ── Property Operations Phase 7: rent paid online by the tenant (Razorpay) ──
  // Empty on every other entry.
  tenantName: { type: String, default: undefined },
  online: {
    _id: false,
    orderId:   { type: String },        // order_… (Razorpay)
    paymentId: { type: String },        // pay_…
    method:    { type: String },        // upi, card, netbanking, wallet…
    rentOrder: { type: mongoose.Schema.Types.ObjectId },   // the RentOrder it came from
    total:     { type: Number },        // what the tenant paid in all (₹), with the fee when the tenant pays it
    booking:   { type: mongoose.Schema.Types.ObjectId },   // Phase 8: the booking amount, credited at move-in
  },
  // What goes to the owner's bank (Razorpay Route transfer), and where it is.
  payout: {
    _id: false,
    status:     { type: String },       // "pending" (on the way) | "on_hold" | "settled" (in the bank) | "failed" | "reversed"
    amount:     { type: Number },       // to the owner's bank (₹)
    gatewayFee: { type: Number },
    commission: { type: Number },
    feePaidBy:  { type: String },       // "tenant" | "owner"
    accountId:  { type: String },       // acc_… (the owner's linked account)
    transferId: { type: String },       // trf_…
    settledAt:  { type: Date },
    checkedAt:  { type: Date },
    error:      { type: String }
  }

});



module.exports = mongoose.model("Payment", paymentSchema);
