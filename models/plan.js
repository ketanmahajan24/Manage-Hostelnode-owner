/* ============================================================
   models/plan.js  —  Subscriptions Phase 1

   A subscription plan, created and edited only from the admin
   panel (/admin/plans). New collection ("plans"); no existing
   collection or record is changed.
============================================================ */

const mongoose = require("mongoose");
const { LIMITS, FEATURES, DURATION_UNITS, ROLES } = require("../config/planFeatures");

// limits: { maxProperties: Number|null, ... }   null = unlimited
const limitFields = {};
LIMITS.forEach(l => { limitFields[l.key] = { type: Number, default: null, min: 0 }; });

// features: { reports: Boolean, ... }
const featureFields = {};
FEATURES.forEach(f => { featureFields[f.key] = { type: Boolean, default: false }; });

const planSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 200, default: "" },

  // Whole rupees. 0 = free.
  price:       { type: Number, required: true, min: 0, default: 0 },
  // Optional "was" price, shown crossed out. null = none.
  strikePrice: { type: Number, min: 0, default: null },

  duration: {
    value: { type: Number, required: true, min: 1, default: 1 },
    unit:  { type: String, enum: DURATION_UNITS.map(u => u.key), default: "month" },
  },

  // Optional: after this moment the plan can no longer be bought.
  offerEndsAt: { type: Date, default: null },

  limits:   limitFields,
  features: featureFields,

  // Free-text bullets shown on the plan card.
  displayPoints: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
  badge:         { type: String, trim: true, maxlength: 24, default: "" },

  isVisible: { type: Boolean, default: true },   // shown to owners
  sortOrder: { type: Number, default: 0 },
  role:      { type: String, enum: ROLES.map(r => r.key), default: "normal" },

  // Set when a plan that owners have bought is "removed": hidden and
  // not buyable, but kept so existing subscribers are not affected.
  archivedAt: { type: Date, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

planSchema.index({ archivedAt: 1, sortOrder: 1 });

module.exports = mongoose.models.Plan || mongoose.model("Plan", planSchema);
