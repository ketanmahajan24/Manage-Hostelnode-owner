const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
 user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User", // This references the User collection
        // required: true,
    },
  memberId: { 
    type: mongoose.Schema.Types.ObjectId,  
    ref: "Member", 
    required: true },

  roomId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Room", 
    // required: true 
  },
 
  roomFees:{ 
      type: Number, 
      required: true,
      default :0
      },
  totalFees:{ 
    type: Number, 
    required: true,
    default :0
    },
    advancedPaid: { 
      type: Number, 
      // required: true 
      default :0
      },
    amountPaid:{
    type: Number, 
    // required: true 
    default :0
    },
 
    dueAmount: { 
      type: Number, 
      // required: true 
      default :0
      },
  paymentDate: { 
    type: Date, 
    default: Date.now 
    },
  paymentMode: { 
    type: String, 
    // enum: ["Cash", "Card", "UPI", "Bank Transfer"], 
    // required: true 
    },
  payableDate: {
     type: Date 
    },
  // Property Operations Phase 1: "2026-10" on monthly rent charges added by
  // utils/monthlyRent.js, so a month is never charged twice. Empty on everything else.
  chargeMonth: {
    type: String
  },
  status: { 
    type: String, 
    enum: ["Paid", "Due","Advanced"], 
    default: "Due" 
    }

});



module.exports = mongoose.model("Payment", paymentSchema);
