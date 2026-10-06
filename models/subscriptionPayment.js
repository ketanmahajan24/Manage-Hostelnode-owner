/* ============================================================
   models/subscriptionPayment.js  —  Subscriptions Phase 3

   One record per Razorpay order an owner starts for a plan.
   New collection ("subscriptionpayments").

   This is NOT the tenants' rent payments (models/payment.js):
   that collection is not touched.

   This file is identical in both repos. Keep them the same.
============================================================ */

const mongoose = require("mongoose");

const subscriptionPaymentSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true, index: true },
  plan:  { type: mongoose.Schema.Types.ObjectId, ref: "Plan",  required: true },

  // The plan exactly as it was when the owner pressed Pay. This is what they get.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },

  amount:      { type: Number, required: true, min: 1 },   // whole rupees
  amountPaise: { type: Number, required: true, min: 100 }, // what Razorpay is asked for
  currency:    { type: String, default: "INR" },

  receipt:           { type: String, required: true, unique: true },   // our receipt number
  razorpayOrderId:   { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, default: undefined },             // set once paid

  // created  = order made, not paid yet
  // paid     = money received
  // failed   = the last attempt failed (the owner can retry)
  // refunded = you refunded it in the Razorpay dashboard
  status: { type: String, enum: ["created", "paid", "failed", "refunded"], default: "created", index: true },

  method:        { type: String, default: "" },    // upi / card / netbanking … when Razorpay tells us
  failureReason: { type: String, default: "" },
  // How we learnt it was paid: the owner's browser, Razorpay's webhook, or you in admin.
  via:           { type: String, enum: ["", "checkout", "webhook", "admin"], default: "" },

  paidAt:       { type: Date, default: null },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null },  // the plan it activated
  fulfilledAt:  { type: Date, default: null },
  billed:       { type: Boolean, default: false },   // Billing-history line added
  lockAt:       { type: Date, default: null },       // short lock while a plan is being activated
  markedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
}, { timestamps: true });

subscriptionPaymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
subscriptionPaymentSchema.index({ createdAt: -1 });

module.exports = mongoose.models.SubscriptionPayment || mongoose.model("SubscriptionPayment", subscriptionPaymentSchema);
