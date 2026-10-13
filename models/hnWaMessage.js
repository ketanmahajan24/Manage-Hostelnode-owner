/* ============================================================
   models/hnWaMessage.js  —  Admin Console Phase 1 (WhatsApp log)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   One row per WhatsApp message HostelNode sends (and per message
   people send to the HostelNode number). Written by utils/waSend.js;
   Meta's receipts (sent → delivered → read, or failed) update the row
   through the WhatsApp webhook. Phone numbers are stored masked plus a
   hash (to match a person later), never in full. Kept 365 days.
============================================================ */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const hnWaMessageSchema = new Schema({
  at:        { type: Date, default: Date.now },
  site:      { type: String, default: "" },
  direction: { type: String, default: "out" },   // out (we sent) | in (someone wrote to us)
  category:  { type: String, default: "other" }, // otp | leads | messages | bookings | tenants | rent | billing | flatmate | bot | chat | other
  template:  { type: String, default: "" },      // Meta template name ("" for free text)
  lang:      { type: String, default: "" },
  kind:      { type: String, default: "" },      // template | text | interactive | image | document | …
  toMasked:  { type: String, default: "" },      // the other person's number, masked: "98••••••10"
  toHash:    { type: String, default: "" },      // keyed hash of that number (utils/hnPii.js, HN_PII_KEY)
  refs: {
    _id: false,
    owner:   { type: Schema.Types.ObjectId, default: null },
    student: { type: Schema.Types.ObjectId, default: null },
    member:  { type: Schema.Types.ObjectId, default: null },
    booking: { type: Schema.Types.ObjectId, default: null },
  },
  wamid:     { type: String, default: "" },      // Meta's message id
  status:    { type: String, default: "sent" },  // off (switched off) | failed | sent | delivered | read | received (in)
  rank:      { type: Number, default: 1 },       // 0 off · 1 sent · 2 delivered · 3 read · 4 failed (receipts only move it up)
  body:      { type: String, default: "" },      // incoming messages only: what the person wrote (first 500 characters)
  error:     { _id: false, code: { type: String, default: "" }, message: { type: String, default: "" } },
  sentAt:      { type: Date },
  deliveredAt: { type: Date },
  readAt:      { type: Date },
  failedAt:    { type: Date },
  pricing:   { _id: false, category: { type: String, default: "" }, billable: { type: Boolean, default: null } },
}, { versionKey: false });

hnWaMessageSchema.index({ at: -1 });
hnWaMessageSchema.index({ wamid: 1 }, { unique: true, partialFilterExpression: { wamid: { $gt: "" } }, name: "wamid_unique" });
hnWaMessageSchema.index({ toHash: 1, at: -1 });
hnWaMessageSchema.index({ category: 1, at: -1 });
hnWaMessageSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600, name: "ttl_365d" });

module.exports = mongoose.models.HnWaMessage || mongoose.model("HnWaMessage", hnWaMessageSchema, "hn_wa_messages");
