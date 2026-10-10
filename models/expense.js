/* ============================================================
   models/expense.js  —  Property Operations Phase 9: expenses

   Money the owner spends on a property (electricity bill, staff
   salary, food, repairs…). Used by Reports → Expenses & profit:
   profit = rent collected − expenses, per property, per month.
   A deleted expense is kept (deletedAt) and no longer counted.
============================================================ */
const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema({
  owner:    { type: mongoose.Schema.Types.ObjectId, ref: "Owner", required: true },
  hostel:   { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", required: true },
  category: { type: String, required: true },          // electricity | water | salary | food | repairs | internet | landlord | other
  amount:   { type: Number, required: true },          // ₹, whole rupees
  date:     { type: Date, required: true },            // the day it was spent (India time, start of day)
  month:    { type: String, required: true },          // "2026-10" (from date), for quick monthly totals
  note:     { type: String, default: "" },
  // Bill photo or PDF, kept privately (only this owner can open it).
  bill: {
    _id: false,
    file: { type: String },                            // random file name in the private expense-bills folder
    mime: { type: String },
    size: { type: Number },
    name: { type: String },
  },
  createdBy: { _id: false, id: { type: mongoose.Schema.Types.ObjectId }, name: { type: String, default: "" } },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

expenseSchema.index({ owner: 1, month: 1 });

module.exports = mongoose.models.Expense || mongoose.model("Expense", expenseSchema);
