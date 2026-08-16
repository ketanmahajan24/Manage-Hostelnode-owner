const mongoose = require("mongoose");

/* =========================
   ROOM SUB-SCHEMA
========================= */
const roomSchema = new mongoose.Schema({
  type: {
    type: String, // Single, Double, Triple
    required: true 
  },
  price: {
    type: Number,
    required: true
  },
  deposit: {
    type: Number,
    default: 0
  },
  features: [String], // AC, Attached Bathroom, etc.
  available: {
    type: Boolean,
    default: true
  }
}, { _id: false });

/* =========================
   REVIEW SUB-SCHEMA
========================= */
const reviewSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Student",
    required: true
  },
  userName:  String,
  avatar:    String,
  rating: {
    type: Number,
    min: 1,
    max: 5,
    required: true
  },
  comment:   String,
  date: {
    type: Date,
    default: Date.now
  }
}, { _id: true });   // ← keep _id so we can delete individual reviews

/* =========================
   MAIN LISTING SCHEMA
========================= */
const listingSchema = new mongoose.Schema({

  /* 🔗 OWNER */
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Owner",
    required: true
  },

  /* 🏷️ BASIC INFO */
  title: {
    type: String,
    required: true,
    trim: true
  },

  slug: {
    type: String,
    unique: true,
    lowercase: true
  },

  description: {
    type: String
  },

  /* 📍 LOCATION */
  location: {
    address: String,
    city: {
      type: String
    },
    state: String,
    country: {
      type: String,
      default: "India"
    },
    pincode: String,
    nearCollege: String,

    // for maps (future)
    coordinates: {
      lat: Number,
      lng: Number
    }
  },

  /* 🏠 PROPERTY DETAILS */
  propertyType: {
    type: String,
    enum: ["Hostel", "PG", "Flat"],
    default: "Hostel"
  },

  gender: {
    type: String,
    enum: ["Boys", "Girls", "Co-ed"],
    required: true
  },

  capacity: Number,

  /* 💰 PRICING */
  startingPrice: {
    type: Number,
    required: true
  },

  deposit: Number,

  /* 🛏️ ROOMS */
  rooms: [roomSchema],

  /* 🖼️ MEDIA */
  images: {
    type: [String],
    validate: [arr => arr.length > 0, "At least one image required"]
  },

  /* 🧰 FEATURES */
  amenities: [String],
  rules: [String],

  /* 📞 CONTACT */
  contact: {
    phone: String,
    whatsapp: String
  },

  /* ⭐ RATINGS */
  rating: {
    type: Number,
    default: 0
  },

  reviewCount: {
    type: Number,
    default: 0
  },

  reviews: [reviewSchema],

  /* 📊 ANALYTICS */
  views: {
    type: Number,
    default: 0
  },

  shortlisted: {
    type: Number,
    default: 0
  },

  /* 🔐 STATUS CONTROL */
  status: {
    type: String,
    enum: ["Pending", "Approved", "Rejected"],
    default: "Approved",
    index: true
  },

  isVerified: {
    type: Boolean,
    default: false
  }

}, { timestamps: true });

/* =========================
   🔥 SLUG AUTO-GENERATION
========================= */
listingSchema.pre("save", function (next) {
  if (!this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-");
  }
  next();
});

/* =========================
   ⚡ INDEXES (FAST SEARCH)
========================= */
listingSchema.index({ "location.city": 1 });
listingSchema.index({ startingPrice: 1 });
listingSchema.index({ gender: 1 });

module.exports = mongoose.model("Listing", listingSchema);