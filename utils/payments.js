/* ============================================================
   utils/payments.js  —  Property Operations Phase 5

   Recording money, used by the new Payments pages and by the old
   "Add payment" form (so every payment gets a receipt number and
   "recorded by", whichever form it came from):

   • recordPayment() — cash / UPI / bank payment received by the owner.
   • addCharge()     — an extra charge (electricity, food, …) for a month.
   • cancelEntry()   — a wrong entry is cancelled with a reason (kept,
                       crossed out; nothing is deleted).
   • receiptFor() / statementFor() — what the PDFs show.

   Switch: HN_LEDGER=off in .env shows the old Payments pages again
   (nothing recorded with the new pages is lost).
============================================================ */

const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { TZ } = require("./tenantOps");
const L = require("./ledger");
const T = require("./tenants");
const { withLocks } = require("./locks");

const ledgerOn = () => !/^(off|0|false|no)$/i.test(String(process.env.HN_LEDGER || "").trim());
const inr = T.inr;
const sleep = ms => new Promise(z => setTimeout(z, ms));
const clean = (s, max = 100) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").trim().replace(/<[^>]*>/g, "").slice(0, max) : "");

async function ownerName(id) {
  try { return (await require("../models/owner").findById(id, { name: 1 }).lean())?.name || ""; } catch { return ""; }
}

/** Run fn holding the locks (retrying for a few seconds while someone else holds them). */
async function locked(keys, fn) {
  for (let i = 0; i < 40; i++) {
    const r = await withLocks(keys, fn);
    if (!r.busy) return r.value;
    await sleep(150);
  }
  const e = new Error("busy"); e.code = "busy"; throw e;
}

/** RC-2026-0001, RC-2026-0002 … one series per owner. */
async function nextReceiptNo(ownerId, when) {
  const Owner = require("../models/owner");
  const Payment = require("../models/payment");
  const col = Owner.collection;
  const oid = new mongoose.Types.ObjectId(String(ownerId));
  const start = await Payment.countDocuments({ user: ownerId, receiptNo: { $exists: true, $nin: [null, ""] } });
  await col.updateOne({ _id: oid, "counters.receipt": { $exists: false } }, { $set: { "counters.receipt": start } });
  const r = await col.findOneAndUpdate({ _id: oid }, { $inc: { "counters.receipt": 1 } }, { returnDocument: "after" });
  const doc = r && r.value !== undefined ? r.value : r;
  const n = Number(doc && doc.counters && doc.counters.receipt) || start + 1;
  return `RC-${moment(when).tz(TZ).format("YYYY")}-${String(n).padStart(4, "0")}`;
}

/**
 * Record a payment received by the owner.
 * { ownerId, member, amount, mode ("Cash" | "UPI" | "Bank transfer"), reference, date, note }
 * Returns { payment, dup } — dup: the same payment was sent a moment ago (double tap), nothing new saved.
 */
async function recordPayment({ ownerId, member, amount, mode, reference = "", date = new Date(), note = "", by = null, extra = null }) {
  const Payment = require("../models/payment");
  const Member = require("../models/member");
  return locked([`pay:${member._id}`, `receipt:${ownerId}`], async () => {
    // The same payment sent again within 15 seconds (double tap, refresh) is recorded once.
    // (Same amount, way, reference and day received: two real payments for different days are both kept.)
    const day = moment(date).tz(TZ).startOf("day");
    const recent = (await Payment.find({
      memberId: member._id, amountPaid: amount, paymentMode: mode, cancelledAt: { $exists: false },
      _id: { $gt: mongoose.Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 15) },
    }).sort({ _id: -1 }).lean()).find(p => (p.reference || "") === (reference || "") && moment(p.paymentDate).tz(TZ).isSame(day, "day"));
    if (recent) return { payment: recent, dup: true };

    const receiptNo = await nextReceiptNo(ownerId, date);
    // Phase 7: by = { id, name, role: "tenant" } for rent paid online; extra = the online and payout details.
    const recordedBy = by && by.role ? { id: by.id || undefined, name: by.name || "", role: by.role } : { id: ownerId, name: await ownerName(ownerId), role: "owner" };
    const saved = await new Payment(Object.assign({
      user: ownerId, memberId: member._id, roomId: member.assignedRoom_id || undefined,
      amountPaid: amount, paymentMode: mode, paymentDate: date, status: "Paid",
      kind: "payment", reference: reference || undefined, note: note || undefined, receiptNo,
      recordedBy,
    }, extra || {})).save();
    // On the tenant. Someone who moved out stays moved out (paying old dues does not move them back in).
    await Member.updateOne({ _id: member._id }, { $addToSet: { payments: saved._id }, ...(member.leftDate ? {} : { $set: { status: "Active" } }) });

    // What it paid for, and what is still due: kept on the payment for its receipt.
    const fresh = await Member.findById(member._id).populate("payments");
    const ledger = L.ledgerOf(fresh);
    const appliedTo = L.appliedOf(ledger, saved._id);
    await Payment.updateOne({ _id: saved._id }, { $set: { appliedTo, dueAfter: ledger.due } });
    return { payment: Object.assign(saved.toObject(), { appliedTo, dueAfter: ledger.due }), dup: false };
  });
}

/**
 * Add a charge to a month. { ownerId, member, category, amount, month, note }
 * category "rent" adds rent for a month (e.g. after a wrong rent entry was cancelled); anything else is an extra charge.
 * Returns { charge, dup } — dup: the same charge was sent a moment ago, nothing new saved.
 */
async function addCharge({ ownerId, member, category, amount, month, note = "" }) {
  const Payment = require("../models/payment");
  const Member = require("../models/member");
  return locked([`pay:${member._id}`], async () => {
    const isRent = category === "rent";
    const recent = await Payment.findOne({
      memberId: member._id, roomFees: amount, month, kind: isRent ? "rent" : "extra", cancelledAt: { $exists: false },
      ...(isRent ? {} : { category }),
      _id: { $gt: mongoose.Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 15) },
    }).lean();
    if (recent) return { charge: recent, dup: true };
    // Rent for a month that already has rent: the old one must be cancelled first (no rent charged twice).
    if (isRent) {
      const fresh = await Member.findById(member._id).populate("payments");
      const has = (fresh.payments || []).find(p => p && !p.cancelledAt && L.kindOf(p) === "rent" && L.monthOf(p) === month);
      if (has) return { charge: null, dup: false, rentExists: has };
    }
    const name = await ownerName(ownerId);
    const date = L.chargeDateFor(member, month, new Date(), { rent: isRent });
    const saved = await new Payment({
      user: ownerId, memberId: member._id, roomId: member.assignedRoom_id || undefined,
      roomFees: amount, totalFees: amount, dueAmount: amount, status: "Due", paymentDate: date, payableDate: date,
      kind: isRent ? "rent" : "extra", category: isRent ? undefined : category, month, note: note || undefined, recordedBy: { id: ownerId, name, role: "owner" },
    }).save();
    await Member.updateOne({ _id: member._id }, { $addToSet: { payments: saved._id } });
    return { charge: saved, dup: false };
  });
}

/** Cancel one entry (kept, crossed out, with the reason). Returns the entry, or null when it cannot be cancelled. */
async function cancelEntry({ ownerId, member, entryId, reason }) {
  const Payment = require("../models/payment");
  const entry = (member.payments || []).find(p => p && String(p._id) === String(entryId));
  const obj = entry && (entry.toObject ? entry.toObject() : entry);
  if (!obj || String(obj.memberId) !== String(member._id) || !L.cancellable(member, obj)) return null;
  const name = await ownerName(ownerId);
  const r = await Payment.updateOne({ _id: obj._id, memberId: member._id, cancelledAt: { $exists: false } },
    { $set: { cancelledAt: new Date(), cancelReason: reason, cancelledBy: { id: ownerId, name } } });
  return r.modifiedCount ? obj : null;
}

/** Everything a receipt shows. */
async function receiptFor(ownerId, member, p) {
  const Owner = require("../models/owner");
  const Hostel = require("../models/hostel");
  const [owner, hostel] = await Promise.all([Owner.findById(ownerId, { name: 1, phone: 1 }).lean(), Hostel.findById(member.hostel, { hostelName: 1, city: 1, state: 1 }).lean()]);
  let applied = Array.isArray(p.appliedTo) && p.appliedTo.length ? p.appliedTo : null;
  let dueAfter = typeof p.dueAfter === "number" ? p.dueAfter : undefined;
  if (!applied) {   // an older payment: worked out from the ledger as it is now
    const full = member.payments && member.payments[0] && typeof member.payments[0] === "object" ? member : await require("../models/member").findById(member._id).populate("payments");
    applied = L.appliedOf(L.ledgerOf(full), p._id);
  }
  const by = p.recordedBy && p.recordedBy.name ? `${p.recordedBy.name} (${p.recordedBy.role === "tenant" ? "paid online" : "owner"})` : (owner && owner.name ? owner.name + " (owner)" : "");
  return {
    receiptNo: p.receiptNo || "OLD-" + String(p._id).slice(-6).toUpperCase(), date: T.dayYear(p.paymentDate),
    property: hostel?.hostelName || "", propertyPlace: [hostel?.city, hostel?.state].filter(Boolean).join(", "),
    ownerName: owner?.name || "", ownerPhone: owner?.phone || "",
    tenantName: member.name, tenantMobile: member.mobileNo, room: [member.assignedRoom ? "Room " + member.assignedRoom : "", member.bedLabel ? "bed " + member.bedLabel : ""].filter(Boolean).join(" - "),
    amount: Number(p.amountPaid) || 0, mode: p.paymentMode || "", reference: p.reference || "", note: p.note || "",
    applied, dueAfter, recordedBy: by,
    cancelled: p.cancelledAt ? { at: T.dayYear(p.cancelledAt), reason: p.cancelReason || "" } : null,
  };
}

/** The receipt's "For" line in a few words: "September rent (balance), October rent, Electricity (Oct)". */
const forText = applied => (applied || []).map(a => a.label).join(", ") || "Rent";

/** Everything the statement PDF shows. */
async function statementFor(ownerId, member, viewerId) {
  const Owner = require("../models/owner");
  const Hostel = require("../models/hostel");
  const [owner, hostel] = await Promise.all([Owner.findById(ownerId, { name: 1, phone: 1 }).lean(), Hostel.findById(member.hostel, { hostelName: 1, city: 1, state: 1 }).lean()]);
  const ledger = L.ledgerOf(member);
  const by = e => (e.recordedBy && e.recordedBy.id ? (String(e.recordedBy.id) === String(viewerId) ? (e.recordedBy.name || "owner") : e.recordedBy.name || "") : "");
  const months = ledger.months.map(mo => ({
    label: mo.label, charged: mo.charged, paid: mo.paid, balance: mo.balance, status: mo.status.key === "paid" ? "Paid" : mo.status.label,
    lines: [].concat(
      mo.charges.map(c => ({ text: c.label, amount: c.amount })),
      mo.applied.map(a => ({ text: `Paid ${a.amount !== a.total ? inr(a.amount) + " of " + inr(a.total) : inr(a.total)} - ${a.entry.paymentMode || ""} - ${T.day(a.entry.paymentDate)}${a.entry.receiptNo ? " - " + a.entry.receiptNo : ""}${by(a.entry) ? " - by " + by(a.entry) : ""}`, soft: true })),
      mo.cancelled.map(c => ({ text: `${c.label} cancelled: ${c.entry.cancelReason || ""}`, amount: c.amount, strike: true })),
    ),
  }));
  const dep = Number(member.depositPaid) || 0, agreed = Number(member.depositAmount) || 0;
  return {
    property: hostel?.hostelName || "", propertyPlace: [hostel?.city, hostel?.state].filter(Boolean).join(", "), ownerPhone: owner?.phone || "",
    tenantName: member.name, tenantMobile: member.mobileNo,
    room: [member.assignedRoom ? "Room " + member.assignedRoom : "", member.bedLabel ? "bed " + member.bedLabel : ""].filter(Boolean).join(" - ") || "-",
    stay: T.dayYear(member.joiningDate) + (member.leftDate ? " - " + T.dayYear(member.leftDate) : " - now"),
    made: T.dayYear(new Date()),
    charged: ledger.charged, paid: ledger.paid, due: ledger.due, advance: ledger.advance,
    deposit: { text: agreed || dep ? `${inr(agreed || dep)} agreed - ${inr(dep)} collected${member.settlement && member.settlement.at && !member.settlement.undoneAt ? " - settled at move-out" : " - held"}` : "" },
    months,
  };
}

module.exports = { ledgerOn, recordPayment, addCharge, cancelEntry, receiptFor, statementFor, forText, nextReceiptNo, clean };
