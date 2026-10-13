/* ============================================================
   models/hnPresence.js  —  Admin Console Phase 1 (tracking)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   Who is on a site right now: one row per person (or per anonymous
   browser), updated on each page and by a light heartbeat while a
   page stays open. "Online now" = seen in the last 2 minutes.
============================================================ */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const hnPresenceSchema = new Schema({
  _id:    { type: String },                      // "<site>:<actor id or visitor id>"
  site:   { type: String, default: "" },
  actor:  { _id: false, kind: { type: String, default: "guest" }, id: { type: Schema.Types.ObjectId, default: null }, name: { type: String, default: "" } },
  vid:    { type: String, default: "" },
  path:   { type: String, default: "" },
  label:  { type: String, default: "" },
  geo:    { _id: false, src: String, city: String, region: String, country: String, lat: Number, lng: Number, acc: Number },
  ua:     { _id: false, browser: String, os: String, device: String },
  ref:    { type: String, default: "" },
  since:  { type: Date, default: Date.now },     // start of this visit
  at:     { type: Date, default: Date.now },     // last seen
  internal: { type: Boolean, default: false },
}, { versionKey: false });

hnPresenceSchema.index({ at: -1 });
hnPresenceSchema.index({ at: 1 }, { expireAfterSeconds: 3600, name: "ttl_1h" });

module.exports = mongoose.models.HnPresence || mongoose.model("HnPresence", hnPresenceSchema, "hn_presence");
