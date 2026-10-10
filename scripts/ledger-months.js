/* ============================================================
   scripts/ledger-months.js  —  Property Operations Phase 5 (one-time, optional)

   Labels the payment entries made before Phase 5, so each one's month
   and kind are saved on it instead of being worked out every time:
     • kind  — rent / payment / deduction / refund / depositAdjust
     • month — "2026-09" on older rent charges that have no month yet
               (the month of their date, India time)
   Nothing else is changed: no amount, date or tenant is touched, and
   nothing is deleted. The ledger works the same before and after; this
   only makes old entries stay in the month they were charged for.

     node scripts/ledger-months.js           shows what it would change; changes nothing
     node scripts/ledger-months.js --apply   makes the changes

   Safe to run more than once (entries already labelled are skipped).
   Uses MONGO_URL from .env.
============================================================ */

require("dotenv").config();
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Payment = require("../models/payment");
const { kindOf } = require("../utils/ledger");

const APPLY = process.argv.includes("--apply");

(async () => {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is not set.");
  await mongoose.connect(process.env.MONGO_URL);
  const cursor = Payment.find({ $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }] }, { roomFees: 1, amountPaid: 1, paymentMode: 1, paymentDate: 1, chargeMonth: 1, month: 1 }).lean().cursor();
  const counts = {};
  let seen = 0, changed = 0;
  for await (const p of cursor) {
    seen++;
    const kind = kindOf(p);
    if (kind === "other") continue;   // an empty entry (no charge, no payment): left as it is
    const set = { kind };
    if (Number(p.roomFees) > 0 && !p.chargeMonth && !p.month && p.paymentDate) set.month = moment(p.paymentDate).tz("Asia/Kolkata").format("YYYY-MM");
    counts[kind] = (counts[kind] || 0) + 1;
    changed++;
    if (APPLY) await Payment.updateOne({ _id: p._id, $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }] }, { $set: set });
  }
  console.log(`${seen} older entries looked at; ${changed} ${APPLY ? "labelled" : "would be labelled"}:`, JSON.stringify(counts));
  if (!APPLY) console.log("Nothing was changed. Run again with --apply to save the labels.");
  await mongoose.disconnect();
})().catch(err => { console.error("ledger-months failed:", err.message); process.exit(1); });
