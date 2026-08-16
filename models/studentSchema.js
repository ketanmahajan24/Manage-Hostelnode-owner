const mongoose = require("mongoose");

/* ============================================================
   STUDENT SCHEMA — HostelNode
   Quick signup: firstName, lastName, phone, OTP
   Profile fields filled later via /student/edit-profile
============================================================ */

const studentSchema = new mongoose.Schema({

  /* ── CORE (filled at signup) ── */
  firstName: {
    type: String,
    required: true,
    trim: true
  },

  lastName: {
    type: String,
    required: true,
    trim: true
  },

  phone: {
    type: String,
    required: true,
    unique: true,
    match: /^[6-9]\d{9}$/
  },

  /* ── OPTIONAL AUTH ── */
  email: {
    type: String,
    unique: true,
    sparse: true,   // allow multiple nulls
    lowercase: true,
    trim: true
  },

  password: {
    type: String   // optional — phone OTP is primary auth
  },

  /* ── PROFILE (filled via edit) ── */
  profileImage: {
    type: String,
    default: null
  },

  gender: {
    type: String,
    enum: ["Male", "Female", "Other", null],
    default: null
  },

  dob: {
    type: Date,
    default: null
  },

  age: {
    type: Number,
    default: null
  },

  /* ── COLLEGE INFO ── */
  collegeName: {
    type: String,
    trim: true,
    default: null
  },

  course: {
    type: String,
    trim: true,
    default: null   // e.g. "B.Tech", "MBA"
  },

  year: {
    type: String,
    enum: ["1st Year", "2nd Year", "3rd Year", "4th Year", "PG", "Other", null],
    default: null
  },

  /* ── LOCATION ── */
  city: {
    type: String,
    trim: true,
    default: null
  },

  state: {
    type: String,
    trim: true,
    default: null
  },

  pincode: {
    type: String,
    default: null
  },

  /* ── PREFERENCES ── */
  profession: {
    type: String,
    enum: ["Student", "Employee", "Bussiness", "Other", null],
    default: null
  },

 
  /* ── WISHLIST (saved hostels) ── */
  wishlist: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Listing"
  }],

  /* ── STATUS ── */
  isProfileComplete: {
    type: Boolean,
    default: false
  },

  status: {
    type: String,
    enum: ["Active", "Inactive", "Banned"],
    default: "Active"
  },

  role: {
    type: String,
    default: "Student"
  },

  /* ── TIMESTAMPS ── */
  lastLogin: {
    type: Date,
    default: null
  }

}, { timestamps: true });

/* ── Auto-calculate age from dob ── */
studentSchema.pre("save", function (next) {
  if (this.dob) {
    const today = new Date();
    const birth = new Date(this.dob);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    this.age = age;
  }

  // Check profile completeness
  this.isProfileComplete = !!(
    this.gender && this.dob && this.collegeName &&
    this.city && this.course
  );

  next();
});

/* ── Virtual: fullName ── */
studentSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

/* ── Indexes ── */
studentSchema.index({ phone: 1 });
studentSchema.index({ email: 1 });
studentSchema.index({ city: 1 });

module.exports = mongoose.model("Student", studentSchema);
