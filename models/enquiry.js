const mongoose = require("mongoose");

const enquirySchema = new mongoose.Schema({

  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Student",
    required: true
  },

  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Listing",
    required: true
  },

  hostelName: String,

  roomType: String,

  contactMethod: {
    type: String,
    enum: ["call", "whatsapp", "visit"]
  },

  // ── NEW: which option was picked in the Contact Owner modal ──
  actionType: {
    type: String,
    enum: ["request_callback", "whatsapp_callback", "schedule_visit", "virtual_tour"],
    default: "request_callback"
  },

  preferredDate: Date,

  moveIn: String,

  // ── NEW ──
  budgetRange: String,

  message: String,

  status: {
    type: String,
    enum: ["New", "Contacted", "Closed"],
    default: "New"
  },

  // ── NEW: lead temperature ──
  leadCategory: {
    type: String,
    enum: ["Hot", "Warm", "Cold"],
    default: "Warm"
  },
  leadScore: {
    type: Number,
    default: 0
  }

}, { timestamps: true });

module.exports = mongoose.model("Enquiry", enquirySchema);