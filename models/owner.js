const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid"); // For UUIDs

const billingSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  description: { type: String },
  paid: { type: Boolean, default: false }
});

const ownerSchema = new mongoose.Schema({
  uuid: {
    type: String,
    default: uuidv4, // Auto-generate a unique UUID
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  phone: {
    type: String,
    required: true,
    unique: true
  },
  // ✅ NEW (multiple listings support)
  listings: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Listing"
  }],
  // ✅ NEW (multiple hostels support)
  hostels: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Hostel"
  }],
  wordons: [{
    type: String // List of words/tags/keywords
  }],
  billingHistory: [billingSchema], // Array of billing/payment records
  status: {
    type: String,
    enum: ["Active", "Inactive", "Pending", "Banned"], // Possible owner statuses ("Banned" is set from the admin panel)
    default: "Active"
  },
  password: {
    type: String,
    required: true
  },
  location: {
    type: String
  },
  gender: {
    type: String
  },
  dob: {
    type: Date
  },
  businessName: {
    type: String
  },
  businessType: {
    type: String
  },
  whatsapp: {
    type: String
  },
  city: {
    type: String
  },
  state: {
    type: String
  },
  country: {
    type: String
  },
  pincode: {
    type: String
  },
  profileImage: {
    type: String
  },
  resetPasswordToken: {
    type: String
  },
  resetPasswordExpires: {
    type: Date
  },
  otp: String,
  
  otpExpires: Date,
  
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  role: {
    type: String,
    default: "Owner"
  },

  // ── Redesign Phase 4 — account settings & KYC ──
  // All optional with defaults: existing owner records need no update.
  loginAlerts: {            // email on every new login (Settings)
    type: Boolean,
    default: true
  },
  kyc: {
    status: {
      type: String,
      enum: ["Not submitted", "Pending", "Verified", "Rejected"],
      default: "Not submitted"
    },
    docType: {
      type: String,
      enum: ["Aadhaar", "PAN", "Driving licence", "Passport"]
    },
    docNumberMasked: String,  // only the last 4 characters are kept
    docFile: String,          // file name under /secure_uploads/kyc
    submittedAt: Date,
    reviewedAt: Date,
    rejectionReason: String
  }
}, { timestamps: true });

module.exports = mongoose.model("Owner", ownerSchema);