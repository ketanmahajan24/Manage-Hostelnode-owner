const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const roomSchema = new mongoose.Schema({

    floor_id:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Floor",  // 🔑 Foreign key to Floor
      required: true
    },
    floor_name: {
        type: String,
        // required: true,
    },
  room_number: {
    type: String,
    required: true,
  },
  room_fees:{
    type: Number,
    required: true,
  },
  sharing_capacity: {
    type: Number,
    required: true,
    default : 0

  },
   occupied_beds: {
    type: Number,
    required: true,
    default : 0

  },

  hostel: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Hostel",
    required: true   // ⭐ VERY IMPORTANT
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User", // This references the User collection
    required: true,
  },

  // ── Property Operations Phase 2 (rooms and beds) ──
  // "AC", "Non-AC" or "" (not set).
  roomType: { type: String, default: "" },
  // e.g. "Attached bathroom", "Balcony", "Study table".
  amenities: [{ type: String }],
  // One entry per bed: A, B, C… (kept in step with sharing_capacity by utils/beds.js).
  // rent: this bed's own monthly rent when it differs from room_fees (null = room rent).
  // blocked: bed not available (repair etc.), with a short note.
  beds: [{
    _id: false,
    label:     { type: String },
    rent:      { type: Number, default: null },
    blocked:   { type: Boolean, default: false },
    blockNote: { type: String, default: "" },
    note:      { type: String, default: "" },
  }]

});

const Room = mongoose.model("Room", roomSchema);
module.exports = Room;
