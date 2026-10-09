const mongoose=require("mongoose");
const Schema=mongoose.Schema;


const memberSchema = new mongoose.Schema({
   user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User", // This references the User collection
          required: true,
      },
    assignedRoom_id:{
        type: mongoose.Schema.Types.ObjectId, 
        ref: "Room" 
    }, // Linking to Room 
    name:{ type: String,
        required: true 
    },
    fatherName: { 
        type: String 
    },
    mobileNo: { type: String,
        required: true ,
        // unique: true 
    },
    aadharNo: { 
        type: String, 
        // unique: true 
    },
    address: { 
        type: String 
    },
    profession: { 
        type: String 
    },
    hostel: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Hostel",
        required: true
    },
    joiningDate: { 
        type: Date, 
        default: Date.now 
    },
    assignedRoom: {
        type:String, 
    },
    hostel: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Hostel",
        required: true
    },
    status: { 
        type: String, 
        enum: ["Active", "Inactive"], 
        default:"Inactive"
    },
    leftDate: {
        type: Date ,
        default:null
    },
    // Property Operations Phase 1: set when the owner removes a tenant record.
    // The record and its payments are kept (reports stay correct); it just
    // no longer shows in the lists. Empty for every other tenant.
    removedAt: {
        type: Date,
        default: null
    },
    // Property Operations Phase 2: the bed in the room ("A", "B", …).
    bedLabel: {
        type: String,
        default: null
    },
    // Phase 2: this tenant's own monthly rent, fixed when they were moved to a
    // bed with a different rent. Empty = they pay their bed's (room's) rent.
    rent: {
        type: Number,
        default: null
    },
    payments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment"
        }] // Payment history
});


const Member = mongoose.model("Member", memberSchema);
module.exports= Member;
