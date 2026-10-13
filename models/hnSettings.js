/* ============================================================
   models/hnSettings.js  —  Admin Console Phase 1
   SHARED: identical in hostelnode.com and manage.hostelnode.com
   (and the admin console, which is the only one that writes it).

   Switches the HostelNode team changes in the admin console:
     _id "wa"        { all, categories: {rent:false}, templates: {name:false} }  false = off
     _id "tracking"  { on, gpsPrompt, internalIps: [], testPhones: [], testIds: [] }
   The apps read them through utils/hnSettings.js (cached 30 seconds).
============================================================ */
const mongoose = require("mongoose");

const hnSettingsSchema = new mongoose.Schema({
  _id:       { type: String },
  value:     { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { _id: false, id: { type: mongoose.Schema.Types.ObjectId, default: null }, name: { type: String, default: "" } },
}, { versionKey: false, minimize: false });

module.exports = mongoose.models.HnSettings || mongoose.model("HnSettings", hnSettingsSchema, "hn_settings");
