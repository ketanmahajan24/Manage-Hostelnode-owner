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
    // ── Property Operations Phase 3: tenant record from admission to move-out ──
    email:            { type: String, default: "" },
    gender:           { type: String, default: "" },          // "Male", "Female", "Other" or empty
    dob:              { type: Date, default: null },
    guardianName:     { type: String, default: "" },
    guardianMobile:   { type: String, default: "" },
    emergencyContact: { type: String, default: "" },
    // Rent due day (1–31). Empty = the day of the month they joined. 29–31 → last day in short months.
    dueDay:           { type: Number, default: null },
    // Security deposit agreed, and how much of it was received.
    depositAmount:    { type: Number, default: null },
    depositPaid:      { type: Number, default: 0 },
    depositMode:      { type: String, default: "" },
    depositPaidAt:    { type: Date, default: null },
    // Notice: the tenant stays "living" until they are moved out.
    leavingDate:      { type: Date, default: null },
    noticeAt:         { type: Date, default: null },
    noticeReason:     { type: String, default: "" },
    // Admitted from this Leads & CRM enquiry (empty for walk-ins).
    fromEnquiry:      { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry", default: null },
    // Files the owner uploaded (rent agreement, ID…). Kept privately; only this owner can open them.
    documents: [{
        name:       { type: String },
        file:       { type: String },     // random file name in the private tenant-documents folder
        mime:       { type: String },
        size:       { type: Number },
        uploadedAt: { type: Date, default: Date.now }
    }],
    // Deposit settlement made at move-out (the settlement slip).
    settlement: {
        at:          { type: Date },
        slipNo:      { type: String },
        depositHeld: { type: Number },
        advance:     { type: Number },
        dues:        { type: Number },
        deductions:  [{ _id: false, label: String, amount: Number }],
        net:         { type: Number },   // more than 0 = refund to the tenant; less than 0 = to collect
        mode:        { type: String },
        paymentIds:  [{ type: mongoose.Schema.Types.ObjectId }],   // ledger entries made by the settlement (removed on undo)
        undoneAt:    { type: Date }
    },
    // Property Operations Phase 7: a leaving date the tenant asked for on hostelnode.com (My PG).
    // The owner accepts it (it becomes leavingDate above) or declines it. Empty until asked.
    noticeRequest: {
        date:      { type: Date },
        reason:    { type: String },
        at:        { type: Date },
        status:    { type: String },      // "pending" | "accepted" | "declined" | "withdrawn"
        decidedAt: { type: Date },
        by:        { type: String }       // who accepted or declined (owner's name)
    },
    payments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment"
        }] // Payment history
});


const Member = mongoose.model("Member", memberSchema);
module.exports= Member;
