/* ============================================================
   utils/reports.js  —  Property Operations Phase 9: Reports

   Every number is worked out from the same records the rest of the
   dashboard uses, the same way, so Reports always agrees with them:

   • Expected and Collected for a month = the Payments page's numbers
     (routes/paymentsRoutes.js propertyMoney): charges of that month in
     each tenant's ledger (not "advance refunded"), and payments received
     in that month (not cancelled, not "deposit adjusted").
   • Still due and Dues by age = the Dues page (tenants with something
     due now, moved-out tenants who still owe included). Each month's
     unpaid balance is aged from that month's due day.
   • Tenants = not removed (as on every other page).
   • Expenses = models/expense.js (deleted ones not counted).

   Nothing here writes to the database.
============================================================ */

const moment = require("moment-timezone");
const { TZ, NOT_REMOVED } = require("./tenantOps");
const L = require("./ledger");
const T = require("./tenants");

const EXPENSE_CATS = {
  electricity: { label: "Electricity", icon: "⚡" },
  water:       { label: "Water", icon: "💧" },
  salary:      { label: "Staff salary", icon: "👷" },
  food:        { label: "Food", icon: "🍽️" },
  repairs:     { label: "Repairs", icon: "🔧" },
  internet:    { label: "Internet", icon: "📶" },
  landlord:    { label: "Rent to landlord", icon: "🏠" },
  other:       { label: "Other", icon: "🧾" },
};

const MODES = [
  { key: "online", label: "Online (Razorpay)", icon: "💳", color: "#1d5fd1" },
  { key: "cash",   label: "Cash", icon: "💵", color: "#0a7d4c" },
  { key: "upi",    label: "UPI to owner", icon: "📲", color: "#b45309" },
  { key: "bank",   label: "Bank transfer", icon: "🏦", color: "#6a3fd8" },
  { key: "other",  label: "Other", icon: "🧾", color: "#334155" },
];

const AGES = [
  { key: "a15",  label: "0–15 days",    max: 15 },
  { key: "a30",  label: "16–30 days",   max: 30 },
  { key: "a60",  label: "31–60 days",   max: 60 },
  { key: "a61",  label: "Over 60 days", max: Infinity },
];

const num = v => Math.max(0, Math.round(Number(v) || 0));
const obj = p => (p && typeof p.toObject === "function" ? p.toObject() : p);
const monthStart = key => moment.tz(key + "-01", "YYYY-MM-DD", TZ);
const isKey = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));

/** n month keys ending with `end` (oldest first). */
function monthKeys(end, n) {
  const out = [];
  const m = monthStart(end);
  for (let i = n - 1; i >= 0; i--) out.push(m.clone().subtract(i, "months").format("YYYY-MM"));
  return out;
}

/** How a payment was received: online | cash | upi | bank | other. */
function modeOf(p) {
  const m = String(p.paymentMode || "");
  if ((p.recordedBy && p.recordedBy.role === "tenant") || (p.online && p.online.paymentId) || /online/i.test(m)) return "online";
  if (/upi/i.test(m)) return "upi";
  if (/bank|neft|imps|rtgs|transfer/i.test(m)) return "bank";
  if (/cash/i.test(m)) return "cash";
  return "other";
}

/** The owner's tenants (not removed) at these properties, payments populated. */
async function loadMembers(ownerId, hostelIds) {
  const Member = require("../models/member");
  if (!hostelIds.length) return [];
  return Member.find({ user: ownerId, hostel: { $in: hostelIds }, ...NOT_REMOVED }).populate("payments");
}

/**
 * Expected and collected for each month in keys (and by property, by way of payment).
 * members: payments populated. Returns Map key → { expected, expectedTenants, collected, paidTenants, modes{}, hostels Map id → {expected, collected} }
 */
function moneyByMonth(members, keys, now = new Date()) {
  const out = new Map(keys.map(k => [k, { key: k, expected: 0, expectedTenants: 0, collected: 0, paid: new Set(), modes: Object.fromEntries(MODES.map(x => [x.key, 0])), hostels: new Map() }]));
  const hb = (row, h) => { if (!row.hostels.has(h)) row.hostels.set(h, { expected: 0, collected: 0 }); return row.hostels.get(h); };
  for (const m of members) {
    const h = String(m.hostel);
    const lg = L.ledgerOf(m, now);
    for (const mo of lg.months) {
      const row = out.get(mo.key);
      if (!row) continue;
      const exp = mo.charges.filter(c => c.kind !== "refund").reduce((s, c) => s + c.amount, 0);
      if (exp > 0) { row.expected += exp; row.expectedTenants++; hb(row, h).expected += exp; }
    }
    for (const raw of (m.payments || [])) {
      const p = obj(raw);
      if (!p || typeof p !== "object" || !(Number(p.amountPaid) > 0) || L.kindOf(p) !== "payment" || p.cancelledAt) continue;
      const row = out.get(L.ym(p.paymentDate));
      if (!row) continue;
      const a = Number(p.amountPaid);
      row.collected += a; row.paid.add(String(m._id));
      row.modes[modeOf(p)] += a;
      hb(row, h).collected += a;
    }
  }
  for (const row of out.values()) { row.paidTenants = row.paid.size; delete row.paid; }
  return out;
}

/** Who owes money now (the Dues page's list), with each month's balance aged from its due day. */
function duesNow(members, hostelsById, now = new Date()) {
  const today = moment(now).tz(TZ).startOf("day");
  const buckets = AGES.map(a => ({ key: a.key, label: a.label, amount: 0, tenants: 0 }));
  const rows = [];
  for (const m of members) {
    const lg = L.ledgerOf(m, now);
    if (!(lg.due > 0) || lg.notYetDue) continue;
    const mine = AGES.map(() => 0);
    for (const mo of lg.months) {
      if (!(mo.balance > 0)) continue;
      const days = mo.dueOn ? Math.max(0, today.diff(moment(mo.dueOn).tz(TZ).startOf("day"), "days")) : 0;
      mine[AGES.findIndex(a => days <= a.max)] += mo.balance;
    }
    mine.forEach((v, i) => { if (v > 0) { buckets[i].amount += v; buckets[i].tenants++; } });
    rows.push({
      id: String(m._id), name: m.name, mobile: m.mobileNo || "", email: m.email || "", hostelId: String(m.hostel), out: !!m.leftDate,
      room: m.leftDate ? "Moved out " + T.day(m.leftDate) : [m.assignedRoom || "—", m.bedLabel].filter(Boolean).join(" · "),
      property: (hostelsById.get(String(m.hostel)) || {}).hostelName || "",
      since: lg.since, daysLate: lg.daysLate, due: lg.due, dueFor: lg.dueFor, ages: mine,
      tone: T.toneOf(m._id), initials: T.initials(m.name),
    });
  }
  rows.sort((a, b) => b.daysLate - a.daysLate || b.due - a.due || String(a.name).localeCompare(String(b.name)));
  return { rows, buckets, total: rows.reduce((s, r) => s + r.due, 0) };
}

/** Lives here at the end of that day (joined by then, not moved out by then). */
function livingOn(m, end) {
  if (!m.joiningDate || moment(m.joiningDate).tz(TZ).isAfter(end)) return false;
  return !m.leftDate || moment(m.leftDate).tz(TZ).isAfter(end);
}

/** Beds now (per property), tenants living at each month's end, move-ins and move-outs per month. */
async function occupancy(hostels, members, keys, now = new Date()) {
  const Room = require("../models/room");
  const Booking = require("../models/booking");
  const ids = hostels.map(h => h._id);
  const rooms = ids.length ? await Room.find({ hostel: { $in: ids } }, { hostel: 1, sharing_capacity: 1, beds: 1 }).lean() : [];
  const booked = ids.length ? await Booking.find({ hostel: { $in: ids }, status: "accepted" }, { bed: 1 }).lean() : [];
  const living = members.filter(m => !m.leftDate && !m.removedAt);
  const inRoom = new Map();
  for (const m of living) if (m.assignedRoom_id) inRoom.set(String(m.assignedRoom_id), (inRoom.get(String(m.assignedRoom_id)) || 0) + 1);
  const bookedIn = new Map();
  for (const b of booked) if (b.bed && b.bed.room) bookedIn.set(String(b.bed.room), (bookedIn.get(String(b.bed.room)) || 0) + 1);
  const now_ = hostels.map(h => {
    const rs = rooms.filter(r => String(r.hostel) === String(h._id));
    let beds = 0, filled = 0, blocked = 0, bookedN = 0, free = 0;
    for (const r of rs) {
      const cap = Math.max(0, Number(r.sharing_capacity) || 0);
      const f = Math.min(cap, inRoom.get(String(r._id)) || 0);
      const bl = Math.min(cap - f, (r.beds || []).filter(b => b.blocked).length);
      const bk = Math.min(cap - f - bl, bookedIn.get(String(r._id)) || 0);
      beds += cap; filled += f; blocked += bl; bookedN += bk; free += cap - f - bl - bk;
    }
    return { id: String(h._id), name: h.hostelName, beds, filled, blocked, booked: bookedN, free, rooms: rs.length, pct: beds ? Math.round((filled / beds) * 100) : 0 };
  });
  const cur = moment(now).tz(TZ).format("YYYY-MM");
  const months = keys.map(k => {
    const end = k === cur ? moment(now).tz(TZ) : monthStart(k).endOf("month");
    let livingN = 0, ins = 0, outs = 0;
    const inList = [], outList = [];
    for (const m of members) {
      if (livingOn(m, end)) livingN++;
      if (m.joiningDate && L.ym(m.joiningDate) === k) { ins++; inList.push(m); }
      if (m.leftDate && L.ym(m.leftDate) === k) { outs++; outList.push(m); }
    }
    return { key: k, living: livingN, ins, outs, inList, outList };
  });
  const total = now_.reduce((s, x) => ({ beds: s.beds + x.beds, filled: s.filled + x.filled, blocked: s.blocked + x.blocked, booked: s.booked + x.booked, free: s.free + x.free }), { beds: 0, filled: 0, blocked: 0, booked: 0, free: 0 });
  total.pct = total.beds ? Math.round((total.filled / total.beds) * 100) : 0;
  return { now: now_, total, months };
}

/**
 * Leads, bookings and new tenants per month.
 * Bookings: paid and still standing (waiting, accepted or moved in; not declined, expired or cancelled).
 * Lead → tenant: tenants added from a lead ÷ leads (tenants from bookings are shown on their own).
 * all: every listing of the owner; otherwise only listings linked to these properties.
 */
async function leadsByMonth(ownerId, hostelIds, all, keys, members) {
  const Listing = require("../models/listingProperty");
  const Enquiry = require("../models/enquiry");
  const Booking = require("../models/booking");
  const from = monthStart(keys[0]).toDate(), to = monthStart(keys[keys.length - 1]).add(1, "month").toDate();
  const lq = all ? { owner: ownerId } : { owner: ownerId, linkedHostel: { $in: hostelIds } };
  const listingIds = (await Listing.find(lq, { _id: 1 }).lean()).map(l => l._id);
  const enquiries = listingIds.length ? await Enquiry.find({ listing: { $in: listingIds }, createdAt: { $gte: from, $lt: to } }, { createdAt: 1 }).lean() : [];
  const bookings = hostelIds.length ? await Booking.find({ owner: ownerId, hostel: { $in: hostelIds }, paidAt: { $gte: from, $lt: to }, status: { $in: ["requested", "accepted", "moved_in"] } }, { paidAt: 1, amount: 1 }).lean() : [];
  const movedFromBooking = hostelIds.length ? await Booking.find({ owner: ownerId, hostel: { $in: hostelIds }, status: "moved_in", member: { $ne: null } }, { member: 1 }).lean() : [];
  const bookedMembers = new Set(movedFromBooking.map(b => String(b.member)));
  return keys.map(k => {
    const leads = enquiries.filter(e => L.ym(e.createdAt) === k).length;
    const bk = bookings.filter(b => L.ym(b.paidAt) === k);
    let fromLeads = 0, fromBookings = 0, walkIns = 0;
    for (const m of members) {
      if (!m.joiningDate || L.ym(m.joiningDate) !== k) continue;
      if (bookedMembers.has(String(m._id))) fromBookings++;
      else if (m.fromEnquiry) fromLeads++;
      else walkIns++;
    }
    const converted = fromLeads + fromBookings;
    return { key: k, leads, bookings: bk.length, bookingAmount: bk.reduce((s, b) => s + num(b.amount), 0), fromLeads, fromBookings, walkIns, converted, rate: leads ? Math.round((fromLeads / leads) * 100) : null };
  });
}

/** Expenses in these months at these properties (not deleted), newest first. */
async function expensesIn(ownerId, hostelIds, keys) {
  const Expense = require("../models/expense");
  if (!hostelIds.length) return [];
  return Expense.find({ owner: ownerId, hostel: { $in: hostelIds }, month: { $in: keys }, deletedAt: null }).sort({ date: -1, _id: -1 }).lean();
}

/** Everything the Reports page (or a download) shows for one month. */
async function build({ ownerId, hostels, all, key, tab, now = new Date() }) {
  const hostelIds = hostels.map(h => h._id);
  const byId = new Map(hostels.map(h => [String(h._id), h]));
  const keys = monthKeys(key, 12);
  const members = await loadMembers(ownerId, hostelIds);
  const money = moneyByMonth(members, keys, now);
  const m = money.get(key);
  const expenses = await expensesIn(ownerId, hostelIds, keys);
  const expMonth = expenses.filter(e => e.month === key);
  const expTotal = expMonth.reduce((s, e) => s + num(e.amount), 0);
  const dues = duesNow(members, byId, now);
  const out = {
    key, keys, label: L.monthLabel(key), hostels, all,
    money: { ...m, hostels: undefined },
    chart: keys.map(k => ({ key: k, short: moment.tz(k + "-01", TZ).format("MMM"), label: L.monthLabel(k), expected: money.get(k).expected, collected: money.get(k).collected })),
    modes: MODES.map(x => ({ ...x, amount: m.modes[x.key] })).filter(x => x.key !== "other" || x.amount > 0),
    byProperty: hostels.map(h => {
      const r = m.hostels.get(String(h._id)) || { expected: 0, collected: 0 };
      const e = expMonth.filter(x => String(x.hostel) === String(h._id)).reduce((s, x) => s + num(x.amount), 0);
      return { id: String(h._id), name: h.hostelName, expected: r.expected, collected: r.collected, expenses: e, profit: r.collected - e };
    }),
    dues,
    expenses: { list: expMonth.map(e => ({ ...e, cat: EXPENSE_CATS[e.category] || EXPENSE_CATS.other, property: (byId.get(String(e.hostel)) || {}).hostelName || "" })), total: expTotal,
      byCat: Object.entries(EXPENSE_CATS).map(([k, c]) => ({ key: k, ...c, amount: expMonth.filter(e => e.category === k).reduce((s, e) => s + num(e.amount), 0) })).filter(c => c.amount > 0) },
    profit: m.collected - expTotal,
    profitMonths: keys.map(k => { const e = expenses.filter(x => x.month === k).reduce((s, x) => s + num(x.amount), 0); return { key: k, label: L.monthLabel(k), collected: money.get(k).collected, expenses: e, profit: money.get(k).collected - e }; }),
  };
  if (!tab || tab === "money" || tab === "occupancy" || tab === "all") out.occupancy = await occupancy(hostels, members, keys, now);
  if (!tab || tab === "leads" || tab === "all") out.leads = await leadsByMonth(ownerId, hostelIds, all, keys, members);
  return out;
}

module.exports = { EXPENSE_CATS, MODES, AGES, monthKeys, modeOf, isKey, loadMembers, moneyByMonth, duesNow, occupancy, leadsByMonth, expensesIn, build, livingOn };
