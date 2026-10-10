/* ============================================================
   utils/ledger.js  —  Property Operations Phase 5: rent ledger

   One tenant's money, month by month, worked out from the payment
   entries they already have (nothing is copied or moved):

   • A charge is an entry with roomFees > 0 (rent, an extra charge,
     move-out deductions, an advance refunded). It belongs to a month:
     its chargeMonth (rent), its month (extra charges), or the month of
     its date (older entries).
   • A payment is an entry with amountPaid > 0. Payments are applied to
     the oldest unpaid month first, in the order they were received;
     what is left over is advance, used by the next charges.
   • A cancelled entry (cancelledAt) stays in the list, crossed out,
     and counts for nothing.

   The totals are the same as utils/tenantOps.js money() (every other
   page's figures), so the ledger and the rest of the app always agree.
============================================================ */

const moment = require("moment-timezone");
const { TZ, dueDateIn, dueAnchor, nextDueDate } = require("./tenantOps");

const MODES = { cash: "Cash", upi: "UPI", bank: "Bank transfer" };
const CATEGORIES = {
  electricity: { label: "Electricity", icon: "⚡" },
  food:        { label: "Food", icon: "🍽️" },
  laundry:     { label: "Laundry", icon: "🧺" },
  damage:      { label: "Damage", icon: "🔧" },
  lateFee:     { label: "Late fee", icon: "⏰" },
  other:       { label: "Other", icon: "🧾" },
};

const num = v => Math.max(0, Math.round(Number(v) || 0));
const ym = d => moment(d).tz(TZ).format("YYYY-MM");
const monthLabel = key => moment.tz(key + "-01", "YYYY-MM-DD", TZ).format("MMMM YYYY");
const monthShort = key => moment.tz(key + "-01", "YYYY-MM-DD", TZ).format("MMM");
const monthName = key => moment.tz(key + "-01", "YYYY-MM-DD", TZ).format("MMMM");
const asObj = p => (p && typeof p.toObject === "function" ? p.toObject() : p);

/** What an entry is: rent, extra, deduction, refund (charges) or payment, depositAdjust (payments). */
function kindOf(p) {
  if (p.kind) return p.kind;
  if (num(p.roomFees) > 0) {
    if (p.paymentMode === "Move-out deductions") return "deduction";
    if (p.paymentMode === "Advance refunded") return "refund";
    return "rent";
  }
  if (num(p.amountPaid) > 0) return p.paymentMode === "Deposit adjusted" ? "depositAdjust" : "payment";
  return "other";
}
const isCharge = p => num(p.roomFees) > 0;
const isPayment = p => num(p.amountPaid) > 0;
const monthOf = p => (/^\d{4}-\d{2}$/.test(p.chargeMonth || "") ? p.chargeMonth : /^\d{4}-\d{2}$/.test(p.month || "") ? p.month : ym(p.paymentDate || Date.now()));
const byDate = (a, b) => (new Date(a.paymentDate || 0) - new Date(b.paymentDate || 0)) || String(a._id).localeCompare(String(b._id));

/** A short name for a charge: "Rent for October", "Electricity", "Move-out deductions". */
function chargeLabel(p, { long = false } = {}) {
  const k = kindOf(p);
  if (k === "rent") return (long ? "Rent for " + monthLabel(monthOf(p)) : "Rent for " + monthName(monthOf(p)));
  if (k === "extra") { const c = CATEGORIES[p.category] || CATEGORIES.other; return c.label + (p.note ? " · " + p.note : ""); }
  if (k === "deduction") return "Move-out deductions";
  if (k === "refund") return "Advance refunded";
  return "Charge";
}
/** "September rent (balance)", "October rent", "Electricity" — for receipts. */
function receiptLabel(p, part) {
  const k = kindOf(p);
  const base = k === "rent" ? monthName(monthOf(p)) + " rent" : k === "extra" ? (CATEGORIES[p.category] || CATEGORIES.other).label + " (" + monthShort(monthOf(p)) + ")" : chargeLabel(p);
  return part ? base + " (balance)" : base;
}

/**
 * The ledger of one tenant (payments populated).
 * Returns { months: [...oldest first], advance, advanceFrom: [...], charged, paid, due, since, daysLate,
 *           monthsOwed, cancelled: [...], payments: [...] }
 * Each month: { key, label, dueOn, charged, paid, balance, status: {key, label, tone, days}, charges, applied, cancelled }
 */
function ledgerOf(member, now = new Date()) {
  const all = (Array.isArray(member && member.payments) ? member.payments : []).filter(p => p && typeof p === "object").map(asObj);
  const live = all.filter(p => !p.cancelledAt);
  const today = moment(now).tz(TZ).startOf("day");
  const anchor = dueAnchor(member);

  const months = new Map();
  const monthFor = key => {
    if (!months.has(key)) months.set(key, { key, label: monthLabel(key), dueOn: null, charged: 0, paid: 0, balance: 0, charges: [], applied: [], cancelled: [] });
    return months.get(key);
  };
  for (const c of live.filter(isCharge).sort(byDate)) {
    const mo = monthFor(monthOf(c));
    mo.charges.push({ entry: c, kind: kindOf(c), label: chargeLabel(c), amount: num(c.roomFees), left: num(c.roomFees) });
    mo.charged += num(c.roomFees);
    const d = c.paymentDate ? moment(c.paymentDate).tz(TZ).startOf("day") : null;
    // The month falls due on its rent day (or on its first charge, when it has no rent).
    if (d && kindOf(c) === "rent" && !mo.hasRent) { mo.dueOn = d.toDate(); mo.hasRent = true; }
    else if (d && !mo.dueOn) mo.dueOn = d.toDate();
  }
  const ordered = [...months.values()].sort((a, b) => a.key.localeCompare(b.key));

  // Payments, oldest first, fill the oldest unpaid charges first.
  const payments = live.filter(isPayment).sort(byDate);
  const advanceFrom = [];
  const paidFor = new Map();   // payment id → [{ entry (the charge), amount, balance (the charge was already part paid) }]
  for (const p of payments) {
    const parts = [];
    paidFor.set(String(p._id), parts);
    let left = num(p.amountPaid);
    for (const mo of ordered) {
      if (!left) break;
      for (const ch of mo.charges) {
        if (!left) break;
        if (!ch.left) continue;
        const take = Math.min(left, ch.left);
        parts.push({ entry: ch.entry, amount: take, balance: ch.left < ch.amount });
        ch.left -= take; left -= take; mo.paid += take;
        const last = mo.applied[mo.applied.length - 1];
        if (last && String(last.entry._id) === String(p._id)) last.amount += take;
        else mo.applied.push({ entry: p, kind: kindOf(p), amount: take, total: num(p.amountPaid) });
      }
    }
    if (left > 0) advanceFrom.push({ entry: p, amount: left, total: num(p.amountPaid) });
  }

  // Cancelled entries are listed in their month, crossed out.
  for (const c of all.filter(p => p.cancelledAt)) {
    const key = isCharge(c) ? monthOf(c) : ym(c.paymentDate || c.cancelledAt);
    monthFor(key).cancelled.push({ entry: c, kind: kindOf(c), label: isCharge(c) ? chargeLabel(c) : "Payment", amount: num(c.roomFees) || num(c.amountPaid) });
  }
  const list = [...months.values()].sort((a, b) => b.key.localeCompare(a.key));   // newest first, for showing

  let charged = 0, paid = 0, since = null, monthsOwed = 0;
  for (const mo of [...list].reverse()) {
    mo.balance = Math.max(0, mo.charged - mo.paid);
    charged += mo.charged;
    paid += mo.paid;
    const due = mo.dueOn ? moment(mo.dueOn).tz(TZ).startOf("day") : null;
    const days = due ? today.diff(due, "days") : 0;
    if (!mo.charged) mo.status = { key: "none", label: "Cancelled", tone: "slate", days: 0 };
    else if (!mo.balance) mo.status = { key: "paid", label: "Paid", tone: "ok", days: 0 };
    else {
      if (!since && due) since = mo.dueOn;
      monthsOwed++;
      if (days < 0) mo.status = { key: "upcoming", label: "Due " + due.format("D MMM"), tone: "blue", days };
      else if (mo.paid > 0) mo.status = { key: "part", label: days > 0 ? `Part paid · ${days} day${days === 1 ? "" : "s"} late` : "Part paid", tone: "warn", days };
      else if (days === 0) mo.status = { key: "today", label: "Due today", tone: "warn", days };
      else mo.status = { key: "overdue", label: `Overdue · ${days} day${days === 1 ? "" : "s"}`, tone: "bad", days };
    }
  }
  const advance = advanceFrom.reduce((s, a) => s + a.amount, 0);
  const due = Math.max(0, charged - paid);
  const daysLate = due > 0 && since ? Math.max(0, today.diff(moment(since).tz(TZ).startOf("day"), "days")) : 0;
  const owing = [...list].reverse().filter(mo => mo.balance > 0);
  return {
    months: list, advance, advanceFrom, charged, paid, due, since, daysLate, monthsOwed,
    // "Sep balance + Oct": what the due is for, in a few words.
    dueFor: owing.length ? owing.slice(0, 3).map(mo => monthShort(mo.key) + (mo.paid > 0 ? " balance" : "")).join(" + ") + (owing.length > 3 ? " …" : "") : "",
    owing: owing.map(mo => ({ key: mo.key, label: (mo.paid > 0 ? monthName(mo.key) + " rent (balance)" : monthName(mo.key) + (mo.charges.some(c => c.kind === "extra") ? " rent + extras" : " rent")), amount: mo.balance, status: mo.status })),
    notYetDue: owing.length > 0 && owing.every(mo => mo.status.key === "upcoming"),
    payments: payments, paidFor,
  };
}

/** What one payment paid for, from the ledger: [{ label, amount }] (the receipt's "For" line). */
function appliedOf(ledger, paymentId) {
  const out = (ledger.paidFor.get(String(paymentId)) || []).map(x => ({ label: receiptLabel(x.entry, x.balance), amount: x.amount }));
  const adv = ledger.advanceFrom.find(a => String(a.entry._id) === String(paymentId));
  if (adv) out.push({ label: "Advance (for the next rent)", amount: adv.amount });
  return out;
}

/** The months an extra charge can be added to: from the joining month to this month (newest first). */
function chargeMonths(member, now = new Date()) {
  const out = [];
  const start = moment(member.joiningDate || now).tz(TZ).startOf("month");
  for (const m = moment(now).tz(TZ).startOf("month"); !m.isBefore(start) && out.length < 24; m.subtract(1, "month")) out.push({ key: m.format("YYYY-MM"), label: m.format("MMMM YYYY") });
  return out;
}
/**
 * The date a charge added by hand for that month is dated: that month's rent day, never before joining.
 * An extra charge is never dated after today (it is due now); rent keeps its real rent day (it may be coming).
 */
function chargeDateFor(member, key, now = new Date(), { rent = false } = {}) {
  const mm = moment.tz(key + "-01", "YYYY-MM-DD", TZ);
  let d = dueDateIn(dueAnchor(member), mm);
  const j = moment(member.joiningDate || now).tz(TZ).startOf("day");
  const today = moment(now).tz(TZ).startOf("day");
  if (d.isBefore(j)) d = j;
  if (d.isAfter(today) && !rent) d = today;
  return d.toDate();
}

/** Can this entry be cancelled? (Not one made by a move-out settlement that still stands: undo the move-out instead.) */
function cancellable(member, p) {
  if (!p || p.cancelledAt) return false;
  // Phase 7: rent paid online by the tenant is real money confirmed by Razorpay (refunds go through HostelNode support).
  if (p.recordedBy && p.recordedBy.role === "tenant") return false;
  const k = kindOf(p);
  if (k === "depositAdjust" || k === "deduction" || k === "refund") return false;
  const s = member.settlement;
  if (s && s.at && !s.undoneAt && (s.paymentIds || []).some(id => String(id) === String(p._id))) return false;
  return isCharge(p) || isPayment(p);
}

module.exports = { MODES, CATEGORIES, kindOf, monthOf, monthLabel, chargeLabel, receiptLabel, ledgerOf, appliedOf, chargeMonths, chargeDateFor, cancellable, isCharge, isPayment, ym, nextDueDate };
