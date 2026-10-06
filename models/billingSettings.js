/* ============================================================
   models/billingSettings.js  —  Subscriptions Phase 1-4

   One record holding subscription-wide settings, edited from
   /admin/plans. New collection ("billingsettings").
============================================================ */

const mongoose = require("mongoose");

const billingSettingsSchema = new mongoose.Schema({
  key: { type: String, default: "billing", unique: true },

  // Days an owner keeps their plan after it expires, before
  // falling back to the Default plan.
  graceDays: { type: Number, default: 7, min: 0, max: 60 },

  // Phase 2: when on, every owner without any plan record gets the
  // Trial plan the next time they open their dashboard. Off by default,
  // so the trial clock only starts when you decide.
  trialsEnabled: { type: Boolean, default: false },

  // Phase 4: when on, plan limits and feature locks are applied to owners.
  // Off by default, so installing Phase 4 locks nobody until you decide.
  enforcementEnabled: { type: Boolean, default: false },

  // Phase 4: when on, owners see a banner and get emails before (and when)
  // their plan or trial ends.
  remindersEnabled: { type: Boolean, default: false },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

// Read the settings (creating nothing): defaults are returned if no
// record has been saved yet.
billingSettingsSchema.statics.read = async function () {
  const doc = await this.findOne({ key: "billing" }).lean();
  return { graceDays: 7, trialsEnabled: false, enforcementEnabled: false, remindersEnabled: false, ...(doc || {}) };
};

module.exports = mongoose.models.BillingSettings || mongoose.model("BillingSettings", billingSettingsSchema);
