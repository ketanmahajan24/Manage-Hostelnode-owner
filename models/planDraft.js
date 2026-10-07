/* ============================================================
   models/planDraft.js  —  Subscriptions: saved form drafts

   When an owner fills the Add Property or Add Tenant form but is
   at their plan's limit, what they typed is kept here so it is not
   lost. It comes back in the form after they upgrade.

   New collection ("plandrafts"). A draft deletes itself after 30
   days. Nothing here is a real property or tenant until the owner
   submits the form again.
============================================================ */

const mongoose = require("mongoose");

const planDraftSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true, index: true },
  kind:  { type: String, enum: ["property", "tenant"], required: true },
  // The form exactly as typed: field name → value.
  fields: { type: [{ _id: false, n: { type: String, maxlength: 80 }, v: { type: String, maxlength: 500 } }], default: [] },
  // Tenant drafts: which property was selected when it was typed.
  hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", default: null },
  // The database removes the draft by itself at this moment.
  expireAt: { type: Date, required: true },
}, { timestamps: true });

planDraftSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
planDraftSchema.index({ owner: 1, kind: 1, createdAt: -1 });

const PlanDraft = mongoose.models.PlanDraft || mongoose.model("PlanDraft", planDraftSchema);

// If the "delete after 30 days" rule could not be set up in the database, say so in the log.
PlanDraft.on("index", err => { if (err) console.error("PlanDraft index (drafts will not expire by themselves):", err.message); });

module.exports = PlanDraft;
