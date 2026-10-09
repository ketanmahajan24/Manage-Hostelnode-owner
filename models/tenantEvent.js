/* ============================================================
   models/tenantEvent.js  —  Property Operations Phase 3

   One line in a tenant's History: admitted, moved room, rent or due
   day changed, deposit received, notice given, moved out… with who
   did it and when. Payments are shown in History straight from the
   payment records, so they are not repeated here.
============================================================ */
const mongoose = require("mongoose");

const tenantEventSchema = new mongoose.Schema({
  owner:  { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true },
  hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" },
  member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
  kind:   { type: String, required: true },    // admitted, moved, rent, dueDay, deposit, notice, noticeCancel, movedOut, undoMoveOut, details, document
  text:   { type: String, required: true },
  note:   { type: String, default: "" },
  by:     { id: { type: mongoose.Schema.Types.ObjectId }, name: { type: String, default: "" } },
  at:     { type: Date, default: Date.now },
});
tenantEventSchema.index({ member: 1, at: -1 });

module.exports = mongoose.model("TenantEvent", tenantEventSchema);
