/* ============================================================
   models/hnActivity.js  —  Admin Console Phase 1 (tracking)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   One row per thing a person did on either site: a page opened,
   a login, a search, an owner action, a location shared.
   Written in the background by utils/activity.js; read by the
   admin console (admin.hostelnode.com). Kept 180 days.
============================================================ */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const hnActivitySchema = new Schema({
  at:      { type: Date, default: Date.now },
  site:    { type: String, default: "" },        // "main" (hostelnode.com) | "owner" (manage.hostelnode.com)
  type:    { type: String, default: "page" },    // page | login | login_failed | logout | signup | otp_sent | otp_failed | otp_verified | action | search | location
  outcome: { type: String, default: "ok" },      // ok | failed
  actor: {
    _id: false,
    kind: { type: String, default: "guest" },    // owner | student | admin | guest
    id:   { type: Schema.Types.ObjectId, default: null },
    name: { type: String, default: "" },
  },
  vid:     { type: String, default: "" },        // anonymous visitor id (one per browser)
  method:  { type: String, default: "GET" },
  path:    { type: String, default: "" },        // without the query string
  label:   { type: String, default: "" },        // "Recorded a payment", "Search results", …
  area:    { type: String, default: "" },        // tenants | payments | rooms | listings | bookings | leads | account | search | …
  status:  { type: Number, default: 0 },         // HTTP status
  ms:      { type: Number, default: 0 },         // response time
  target:  { _id: false, kind: { type: String, default: "" }, id: { type: String, default: "" } },
  meta:    { type: Schema.Types.Mixed, default: undefined },
  ip:      { type: String, default: "" },
  geo: {
    _id: false,
    src:     { type: String, default: "" },      // "ip" (approx.) | "gps" (exact, user allowed)
    city:    { type: String, default: "" },
    region:  { type: String, default: "" },
    country: { type: String, default: "" },
    lat:     { type: Number, default: null },
    lng:     { type: Number, default: null },
    acc:     { type: Number, default: null },    // GPS accuracy in metres
  },
  ua: {
    _id: false,
    browser: { type: String, default: "" },
    os:      { type: String, default: "" },
    device:  { type: String, default: "" },      // mobile | tablet | desktop
  },
  ref:      { type: String, default: "" },       // where they came from (host only)
  bot:      { type: Boolean, default: false },
  internal: { type: Boolean, default: false },   // HostelNode team, test accounts, office IPs
  logAt:    { type: Date },                       // when the row was written (the live feed follows this)
}, { versionKey: false });

hnActivitySchema.index({ at: -1 });
hnActivitySchema.index({ logAt: -1 });
hnActivitySchema.index({ "actor.id": 1, at: -1 });
hnActivitySchema.index({ type: 1, at: -1 });
hnActivitySchema.index({ vid: 1, at: -1 });
hnActivitySchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 3600, name: "ttl_180d" });

module.exports = mongoose.models.HnActivity || mongoose.model("HnActivity", hnActivitySchema, "hn_activity");
