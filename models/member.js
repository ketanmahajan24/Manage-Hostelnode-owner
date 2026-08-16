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
    payments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment"
        }] // Payment history
});


const Member = mongoose.model("Member", memberSchema);
module.exports= Member;
