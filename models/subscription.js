/* ============================================================
   models/subscription.js  —  Subscriptions Phase 2-4

   One record each time an owner gets a plan: a free trial, a plan
   you grant from admin, or (from Phase 3) a plan paid by Razorpay.
   New collection ("subscriptions"); no existing record is changed.

   The plan's details are COPIED into `snapshot` at that moment, so
   editing or archiving a plan later never changes what an owner
   already has.

   This file is identical in both repos (hostelnode.com and the
   owner dashboard). Keep them the same.
============================================================ */

const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true, index: true },
  plan:  { type: mongoose.Schema.Types.ObjectId, ref: "Plan",  required: true, index: true },

  // Copy of the plan as it was when the owner got it.
  snapshot: {
    name:          { type: String, required: true },
    description:   { type: String, default: "" },
    price:         { type: Number, default: 0 },
    duration:      { value: Number, unit: String },
    limits:        { type: mongoose.Schema.Types.Mixed, default: {} },   // { maxTenants: 60, ... } null = unlimited
    features:      { type: mongoose.Schema.Types.Mixed, default: {} },   // { reports: true, ... }
    displayPoints: { type: [String], default: [] },
    role:          { type: String, default: "normal" },
  },

  // trial    = free trial, started automatically
  // admin    = given by you from the admin panel
  // razorpay = paid online (Phase 3)
  source: { type: String, enum: ["trial", "admin", "razorpay"], required: true },

  // active    = the owner's current plan (it may still be past its expiry date:
  //             "expired" is worked out from expiresAt, not stored)
  // replaced  = a newer plan took over
  // cancelled = you cancelled it from admin
  status: { type: String, enum: ["active", "replaced", "cancelled"], default: "active", index: true },

  startsAt:  { type: Date, required: true },
  expiresAt: { type: Date, default: null },     // null = never expires

  // Set only on trial records: makes "one trial per owner, ever" a database rule.
  trialKey: { type: String, default: undefined },

  // Phase 3: the online payment that bought this plan. A database rule
  // (unique) makes sure one payment can never activate two plans.
  payment: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPayment", default: undefined },

  // Phase 4: which expiry reminders have gone out for this record ("7", "3", "1", "expired").
  remindersSent: { type: [String], default: [] },

  amountPaid: { type: Number, default: 0 },     // whole rupees; 0 for trial / granted
  note:       { type: String, trim: true, maxlength: 300, default: "" },
  grantedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  endedAt:    { type: Date, default: null },    // when it was replaced or cancelled
  endedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
}, { timestamps: true });

subscriptionSchema.index({ owner: 1, status: 1, startsAt: -1 });
subscriptionSchema.index({ trialKey: 1 }, { unique: true, sparse: true });
subscriptionSchema.index({ payment: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.Subscription || mongoose.model("Subscription", subscriptionSchema);
