const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
  phone: String,
  otp: String,
  expiresAt: Date
});

module.exports = mongoose.model("Otp", otpSchema);