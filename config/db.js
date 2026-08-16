
require('dotenv').config() //env variable
const mongoose = require("mongoose");
dbpath=process.env.MONGO_URL;
 
const connectDB = async () => {
  try {
    await mongoose.connect(dbpath, {
    });
    console.log("MongoDB connected...");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
};

module.exports = connectDB;
