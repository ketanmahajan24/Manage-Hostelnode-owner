const mongoose = require("mongoose");

const hostelSchema = new mongoose.Schema({
  hostelId: {
    type: String,
    unique: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Owner",
    required: true
  },
  hostelName: {
    type: String,
    required: true
  },
  city: String,
  state: String,
  country: String,
  pincode: String,
  location: String,
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active"
  }
}, { timestamps: true });

module.exports = mongoose.model("Hostel", hostelSchema);