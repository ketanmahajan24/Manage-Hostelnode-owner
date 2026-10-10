/* ============================================================
   utils/bookings.js  —  Property Operations Phase 8: booking from listings
   SHARED: identical in the owner dashboard and hostelnode.com.

   A student books a bed from a listing and pays a booking amount online.
   The Razorpay order carries a Route transfer of the owner's share, made
   ON HOLD: Razorpay keeps it until the student moves in. Then:
   • the owner accepts (picks the exact bed) or declines (full refund);
   • no answer in 72 hours: cancelled with a full refund;
   • the student cancels: full refund before acceptance; after it, the
     owner's rule (full / half / none, up to N days before move-in);
   • move-in day: Admit credits the amount (rent or deposit) and the hold
     is released, so the owner's share goes to their bank.

   Refunds take the owner's share back first (a transfer reversal), then
   refund the student. Each step checks what Razorpay already did, so a
   retry never refunds twice. Every amount is worked out on the server.

   Switch: HN_BOOKINGS=off (either site) stops new bookings.
============================================================ */

const crypto = require("crypto");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const rzp = require("./razorpay");
const PO = require("./payouts");
const OR = require("./onlineRent");
const { TZ, LIVING } = require("./tenantOps");
const { withLocks } = require("./locks");

const switchedOn = () => !/^(off|0|false|no)$/i.test(String(process.env.HN_BOOKINGS || "").trim());
const enabled = () => switchedOn() && PO.ready();
const ANSWER_H = 48, EXPIRE_H = 72, MAX_DAYS = 60, MIN_AMOUNT = 100, REUSE_MS = 15 * 60e3, MAX_TRIES = 12;
const PAY = /^pay_[A-Za-z0-9]{6,40}$/, TRF = /^trf_[A-Za-z0-9]{6,40}$/;
const OPEN = ["requested", "accepted"];
const inr = n => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const day = d => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "");
const dayTime = d => (d ? new Date(d).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ }) : "");
const isId = v => typeof v === "string" ? /^[0-9a-f]{24}$/i.test(v) && mongoose.isValidObjectId(v) : v instanceof mongoose.Types.ObjectId;
const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };
const sleep = ms => new Promise(z => setTimeout(z, ms));
const Booking = () => require("../models/booking");

/* ── Settings of one listing ────────────────────────────────── */
const AFTER = { full: "Full refund", half: "Half refund", none: "No refund" };
function settingsOf(listing) {
  const b = (listing && listing.booking) || {};
  const days = Number(b.refundDays);
  return {
    on: b.on === true,
    amountType: b.amountType === "fixed" ? "fixed" : "rent",
    amount: Math.max(0, Math.round(Number(b.amount) || 0)),
    countsTowards: b.countsTowards === "deposit" ? "deposit" : "rent",
    refundAfter: ["full", "half", "none"].includes(b.refundAfter) ? b.refundAfter : "half",
    refundDays: Number.isInteger(days) && days >= 0 && days <= 60 ? days : 7,
  };
}
const amountFor = (s, room) => (s.amountType === "fixed" ? s.amount : Math.round(Number(room && room.price) || 0));
/** "Full refund until the owner accepts… After they accept: 50% refund up to 7 days before move-in, none after." */
function ruleText(rule) {
  const after = rule.after === "full" ? "a full refund" : rule.after === "half" ? "a 50% refund" : "no refund";
  if (rule.after === "none") return "Full refund until the owner accepts, or if they decline or don't answer in 72 hours. After they accept: no refund.";
  return `Full refund until the owner accepts, or if they decline or don't answer in 72 hours. After they accept: ${after} up to ${rule.days} day${rule.days === 1 ? "" : "s"} before move-in, none after.`;
}

/* ── Free beds of each room type (live) ─────────────────────── */
async function freeByType(listing) {
  const Room = require("../models/room");
  const Member = require("../models/member");
  const { roomsForType } = require("./beds");
  const hostelId = listing.linkedHostel;
  const [rooms, living, accepted, requested] = await Promise.all([
    Room.find({ hostel: hostelId }, { sharing_capacity: 1, beds: 1, room_number: 1, room_fees: 1 }).lean(),
    Member.find({ hostel: hostelId, ...LIVING }, { assignedRoom_id: 1 }).lean(),
    Booking().find({ hostel: hostelId, status: "accepted" }, { bed: 1 }).lean(),
    Booking().find({ listing: listing._id, status: "requested" }, { typeIndex: 1 }).lean(),
  ]);
  const count = (list, key) => { const m = new Map(); for (const x of list) { const k = String(key(x) || ""); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const livingIn = count(living, x => x.assignedRoom_id), bookedIn = count(accepted, x => x.bed && x.bed.room);
  const freeIn = r => Math.max(0, (Number(r.sharing_capacity) || 0) - (livingIn.get(String(r._id)) || 0) - (r.beds || []).filter(b => b.blocked).length - (bookedIn.get(String(r._id)) || 0));
  return (listing.rooms || []).map((lr, i) => {
    const rs = roomsForType(lr, rooms);
    const waiting = requested.filter(b => b.typeIndex === i).length;
    return { i, type: lr.type, price: Number(lr.price) || 0, deposit: Number(lr.deposit) || 0, matched: rs.length > 0, free: rs.length ? Math.max(0, rs.reduce((s, r) => s + freeIn(r), 0) - waiting) : 0 };
  });
}

/**
 * Can students book from this listing now? { on, why, types, hostel, account, settings }
 * why: off | not_on | not_linked | no_account
 */
async function bookability(listing, { live = true } = {}) {
  const s = settingsOf(listing);
  const out = { on: false, why: "", types: [], hostel: null, account: null, settings: s };
  if (!enabled()) return Object.assign(out, { why: "off" });
  if (!s.on) return Object.assign(out, { why: "not_on" });
  if (!listing.linkedHostel) return Object.assign(out, { why: "not_linked" });
  const Hostel = require("../models/hostel");
  const PayoutAccount = require("../models/payoutAccount");
  const ownerId = listing.owner && listing.owner._id ? listing.owner._id : listing.owner;
  const [hostel, account] = await Promise.all([Hostel.findById(listing.linkedHostel, { hostelName: 1, owner: 1, city: 1 }).lean(), PayoutAccount.findOne({ owner: ownerId }).lean()]);
  if (!hostel || String(hostel.owner) !== String(ownerId)) return Object.assign(out, { why: "not_linked" });
  if (!PO.canReceive(account) || !account.accountId) return Object.assign(out, { why: "no_account", hostel });
  const types = live ? await freeByType(listing) : (listing.rooms || []).map((lr, i) => ({ i, type: lr.type, price: Number(lr.price) || 0, deposit: Number(lr.deposit) || 0, matched: typeof lr.freeBeds === "number", free: Number(lr.freeBeds) || 0 }));
  for (const t of types) { t.amount = amountFor(s, t); t.can = t.matched && t.free > 0 && t.amount >= MIN_AMOUNT; }
  return Object.assign(out, { on: true, types, hostel, account });
}

/** Move-in dates a student can choose: today to 60 days ahead (India time). */
function moveInRange(now = new Date()) {
  const t = moment(now).tz(TZ).startOf("day");
  return { min: t.clone(), max: t.clone().add(MAX_DAYS, "days") };
}
function dateIn(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = moment.tz(s, "YYYY-MM-DD", true, TZ);
  return d.isValid() ? d : null;
}

/** The student's KYC for booking: { required, ok, name } (own DigiLocker verification of their login number). */
async function kycOf(student) {
  const kyc = require("./kyc");
  const s = await kyc.settings();
  const rec = student && student.phone ? await kyc.recordFor(student.phone) : null;
  const own = !!(rec && rec.status === "verified" && String(rec.student || "") === String(student._id));
  return { required: !!s.canVerify, ok: own || !s.canVerify, verified: own, name: own ? rec.name || "" : "" };
}

/**
 * Start (or reuse) the Razorpay order for a booking. listing: lean with owner id.
 * Returns { booking (lean), quote }. Throws err.code: not_available | type | date | kyc | twice | amount.
 */
async function startOrder({ listing, student, typeIndex, moveIn }) {
  const PayoutSettings = require("../models/payoutSettings");
  const av = await bookability(listing);
  if (!av.on) throw fail("not_available", "Booking is not available for this listing right now.");
  const t = av.types[Number(typeIndex)];
  if (!t || !t.can) throw fail("type", "That room type has no free bed right now. Choose another.");
  const d = dateIn(moveIn);
  const r = moveInRange();
  if (!d || d.isBefore(r.min) || d.isAfter(r.max)) throw fail("date", `Choose a move-in date from today to ${r.max.format("D MMM")}.`);
  const k = await kycOf(student);
  if (!k.ok) throw fail("kyc", "Verify your Aadhaar with DigiLocker first.");
  const twice = await Booking().findOne({ student: student._id, listing: listing._id, status: { $in: OPEN } }, { _id: 1 }).lean();
  if (twice) throw fail("twice", "You already have a booking at this PG. See My bookings.");
  const q = OR.quote(t.amount, await PayoutSettings.read(), av.account);
  if (q.toOwner < 1) throw fail("amount", "Booking is not available for this listing right now.");
  const amountPaise = q.total * 100, toOwnerPaise = q.toOwner * 100;
  const s = av.settings;
  const recent = await Booking().findOne({
    student: student._id, listing: listing._id, status: "pending_payment", typeIndex: t.i, moveIn: d.toDate(), amountPaise, toOwnerPaise,
    accountId: av.account.accountId, countsTowards: s.countsTowards, "rule.after": s.refundAfter, "rule.days": s.refundDays, createdAt: { $gt: new Date(Date.now() - REUSE_MS) },
  }).sort({ createdAt: -1 }).lean();
  if (recent) return { booking: recent, quote: q };
  const property = String(av.hostel.hostelName || listing.title || "").slice(0, 60);
  const name = [student.firstName, student.lastName].filter(Boolean).join(" ").trim();
  const order = await rzp.call("POST", "/v1/orders", {
    amount: amountPaise, currency: "INR", receipt: "HNB-" + moment().tz(TZ).format("YYYYMMDD") + "-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
    notes: { hn_kind: "booking", listing: String(listing._id), owner: String(av.hostel.owner), student: String(student._id) },
    transfers: [{ account: av.account.accountId, amount: toOwnerPaise, currency: "INR", notes: { student: name.slice(0, 60), property, hn_kind: "booking" }, linked_account_notes: ["student", "property"], on_hold: true }],
  });
  if (!order || typeof order.id !== "string" || Number(order.amount) !== amountPaise) throw new Error("Razorpay order did not match the request");
  const b = await Booking().create({
    owner: av.hostel.owner, hostel: av.hostel._id, listing: listing._id, student: student._id, studentName: name, studentPhone: OR.mobile10(student.phone),
    property: av.hostel.hostelName || listing.title || "", roomType: t.type, typeIndex: t.i, rent: t.price, deposit: t.deposit, moveIn: d.toDate(), kycName: k.name,
    amount: q.amount, fee: q.fee, commission: q.commission, feePaidBy: q.feePaidBy, total: q.total, amountPaise, toOwnerPaise, accountId: av.account.accountId,
    countsTowards: s.countsTowards, rule: { after: s.refundAfter, days: s.refundDays }, razorpayOrderId: order.id, status: "pending_payment",
  });
  return { booking: b.toObject(), quote: q };
}

/** BK-2026-0001 … one series for HostelNode. */
async function nextBookingNo(when) {
  const y = moment(when).tz(TZ).format("YYYY");
  const col = mongoose.connection.collection("hn_counters");
  for (let i = 0; i < 40; i++) {
    const r = await withLocks(["counter:booking"], async () => {
      const doc = await col.findOne({ _id: "booking-" + y });
      const n = (Number(doc && doc.n) || 0) + 1;
      await col.updateOne({ _id: "booking-" + y }, { $set: { n } }, { upsert: true });
      return n;
    });
    if (!r.busy) return `BK-${y}-${String(r.value).padStart(4, "0")}`;
    await sleep(100);
  }
  throw fail("busy", "busy");
}

/** Run fn holding the booking's lock (waiting a few seconds when someone else holds it). */
async function lockedBooking(id, fn, extra = []) {
  for (let i = 0; i < 40; i++) {
    const r = await withLocks([`booking:${id}`].concat(extra), fn);
    if (!r.busy) return r.value;
    await sleep(150);
  }
  throw fail("busy", "Someone is changing this booking right now. Please try again in a moment.");
}
const note = (text, by = "") => ({ at: new Date(), text, by });

/**
 * Record a confirmed payment once. match: { id } or { orderId }. Only after Razorpay's signature
 * was checked, or with a payment fetched from Razorpay and seen as captured.
 * Returns { ok, fresh, booking } or { ok: false, why }.
 */
async function fulfil(match, { paymentId = "", method = "", via = "", at = null } = {}) {
  const found = match.id && isId(String(match.id)) ? await Booking().findById(match.id, { _id: 1 }).lean()
    : typeof match.orderId === "string" && match.orderId ? await Booking().findOne({ razorpayOrderId: match.orderId }, { _id: 1 }).lean() : null;
  if (!found) return { ok: false, why: "not_found" };
  try {
    const out = await lockedBooking(found._id, async () => {
      const b = await Booking().findById(found._id).lean();
      if (b.status !== "pending_payment") {
        if (PAY.test(paymentId) && b.razorpayPaymentId && paymentId !== b.razorpayPaymentId && !(b.history || []).some(h => (h.text || "").includes(paymentId))) {
          await Booking().updateOne({ _id: b._id }, { $push: { history: note(`A second payment ${paymentId} on this booking: not counted; refund it in Razorpay`, "HostelNode") }, $addToSet: { extraPayments: paymentId } });
          console.error("BOOKING: a second payment on a paid booking; refund it in Razorpay:", b.razorpayOrderId, paymentId);
          return { ok: true, fresh: false, duplicate: true, booking: b };
        }
        return { ok: true, fresh: false, booking: b };
      }
      if (!PAY.test(paymentId)) return { ok: false, why: "no_payment" };
      const paidAt = OR.paidDate(at);
      const bookingNo = await nextBookingNo(paidAt);
      await Booking().updateOne({ _id: b._id, status: "pending_payment" }, {
        $set: { status: "requested", razorpayPaymentId: paymentId, method: method || "", paidAt, bookingNo, "payout.status": "on_hold" },
        $push: { history: note(`Paid ${inr(b.total)}${method ? " · " + method.toUpperCase() : ""} (${via || "online"})`, b.studentName) },
      });
      return { ok: true, fresh: true, booking: await Booking().findById(b._id).lean() };
    });
    // Paid from a second tab while another booking at this PG was already open: cancelled with a full refund.
    if (out && out.fresh) {
      // Every open booking at this PG is ranked (this one included) and all but the first paid are cancelled,
      // so whichever payment is recorded last sees both, even when two are paid at the same moment.
      // (An accepted booking is never cancelled this way; then the booking numbers, given in order, decide.)
      const first = (x, y) => ((y.status === "accepted") - (x.status === "accepted")) || String(x.bookingNo || "").localeCompare(String(y.bookingNo || "")) || String(x._id).localeCompare(String(y._id));
      const all = (await Booking().find({ student: out.booking.student, listing: out.booking.listing, status: { $in: OPEN } }, { _id: 1, status: 1, bookingNo: 1 }).lean()).sort(first);
      let closedSelf = null;
      for (const x of all.slice(1).filter(x => x.status !== "accepted")) {
        const c = await close({ id: x._id, kind: "cancelled", by: "system", byName: "HostelNode", reason: "You already have a booking at this PG", mode: "full" }).catch(e => { console.error("Second booking refund (will retry):", e.message); return null; });
        if (String(x._id) === String(out.booking._id)) closedSelf = c || out.booking;
      }
      if (closedSelf) return { ok: true, fresh: false, second: true, booking: closedSelf };
    }
    return out;
  } catch (err) {
    if (err.code === "busy") return { ok: true, pending: true };
    throw err;
  }
}

/** After a booking was paid (fresh): KYC shared with the owner, the owner told, the student's WhatsApp. Never throws. */
function afterPaid(result) {
  if (!result || !result.ok || !result.fresh || !result.booking) return;
  const b = result.booking;
  setImmediate(async () => {
    try {
      if (b.kycName) await require("./kyc").share(b.studentPhone, b.owner, b.hostel).catch(() => {});
      await notifyOwner(b, `New booking: ${b.studentName}`, `${b.roomType} · move in ${day(b.moveIn)} · ${inr(b.amount)} paid. Accept or decline by ${dayTime(answerBy(b))}.`, "new");
      const owner = await require("../models/owner").findById(b.owner, { phone: 1 }).lean();
      await wa("WA_TEMPLATE_BOOKING_NEW", owner && owner.phone, [b.studentName, b.roomType, b.property, day(b.moveIn), inr(b.amount)]);
      await wa("WA_TEMPLATE_BOOKING_REQUESTED", b.studentPhone, [first(b.studentName), b.property, b.roomType, day(b.moveIn), inr(b.total), b.bookingNo]);
    } catch (err) { console.error("Booking paid follow-up (non-fatal):", err.message); }
  });
}
const answerBy = b => new Date(new Date(b.paidAt || b.createdAt).getTime() + ANSWER_H * 3600e3);
const expiresAt = b => new Date(new Date(b.paidAt || b.createdAt).getTime() + EXPIRE_H * 3600e3);
const first = name => String(name || "").trim().split(/\s+/)[0] || "there";

/* ── The owner answers ──────────────────────────────────────── */
/** Beds the owner can pick for a booking: free on the move-in date and not booked. Matching room type first. */
async function bedOptions(b) {
  const Room = require("../models/room");
  const Member = require("../models/member");
  const Listing = require("../models/listingProperty");
  const { roomsForType, natural, bedLabels } = require("./beds");
  const [rooms, living, accepted, listing] = await Promise.all([
    Room.find({ hostel: b.hostel, user: b.owner }).lean(),
    Member.find({ hostel: b.hostel, ...LIVING }, { assignedRoom_id: 1, bedLabel: 1, leavingDate: 1, name: 1 }).lean(),
    Booking().find({ hostel: b.hostel, status: "accepted", _id: { $ne: b._id } }, { bed: 1 }).lean(),
    Listing.findById(b.listing, { rooms: 1 }).lean(),
  ]);
  const lr = listing && listing.rooms ? listing.rooms[b.typeIndex] : null;
  const typeRooms = new Set((lr ? roomsForType(lr, rooms) : []).map(r => String(r._id)));
  const moveIn = moment(b.moveIn).tz(TZ).endOf("day");
  const out = [];
  for (const r of rooms) {
    const labels = (r.beds && r.beds.length ? r.beds.map(x => x.label) : bedLabels(Number(r.sharing_capacity) || 0)).slice(0, Number(r.sharing_capacity) || 0);
    // Tenants without a bed letter (older records) still take a bed: offer only as many as are really free.
    const inRoom = living.filter(x => String(x.assignedRoom_id) === String(r._id));
    const unlabelled = inRoom.filter(x => !x.bedLabel || !labels.includes(x.bedLabel)).length;
    const bookedHere = accepted.filter(a => a.bed && String(a.bed.room) === String(r._id)).length;
    // (When every tenant has a bed letter, each bed is checked one by one below.)
    let room = unlabelled ? Math.max(0, (Number(r.sharing_capacity) || 0) - inRoom.length - bookedHere) : Infinity;
    for (const label of labels) {
      if (room <= 0) break;
      const bed = (r.beds || []).find(x => x.label === label) || {};
      if (bed.blocked) continue;
      if (accepted.some(a => a.bed && String(a.bed.room) === String(r._id) && a.bed.label === label)) continue;
      const m = living.find(x => String(x.assignedRoom_id) === String(r._id) && x.bedLabel === label);
      if (m && !(m.leavingDate && !moment(m.leavingDate).tz(TZ).isAfter(moveIn))) continue;
      const rent = bed.rent !== null && bed.rent !== undefined && bed.rent !== "" ? Number(bed.rent) : Number(r.room_fees) || 0;
      out.push({ value: `${r._id}:${label}`, room: r.room_number, roomId: String(r._id), label, rent, match: typeRooms.has(String(r._id)), freeFrom: m ? m.leavingDate : null });
      room--;
    }
  }
  out.sort((a, c) => (c.match - a.match) || natural(a.room, c.room) || natural(a.label, c.label));
  return out;
}

async function accept({ id, ownerId, bed, byName = "owner" }) {
  const [roomId, label] = String(bed || "").split(":");
  if (!isId(roomId || "") || !/^[A-Z]{1,3}$/.test(label || "")) throw fail("bed", "Choose a bed.");
  const b0 = await Booking().findOne({ _id: id, owner: ownerId }, { _id: 1 }).lean();
  if (!b0) throw fail("missing", "Booking not found.");
  const out = await lockedBooking(b0._id, async () => {
    const b = await Booking().findById(b0._id).lean();
    if (b.status !== "requested") throw fail("state", b.status === "accepted" ? "This booking is already accepted." : "This booking can no longer be accepted.");
    const opts = await bedOptions(b);
    const pick = opts.find(o => o.value === `${roomId}:${label}`);
    if (!pick) throw fail("bed", "That bed is not free on the move-in date any more. Choose another.");
    const r = await Booking().updateOne({ _id: b._id, status: "requested" }, {
      $set: { status: "accepted", bed: { room: new mongoose.Types.ObjectId(roomId), roomNumber: pick.room, label }, acceptedAt: new Date(), decidedBy: byName },
      $push: { history: note(`Accepted · room ${pick.room} bed ${label}`, byName) },
    });
    if (!r.modifiedCount) throw fail("state", "This booking changed a moment ago. Please check it again.");
    return Booking().findById(b._id).lean();
  }, [`bed:${roomId}:${label}`, `room:${roomId}`]);   // (room: the same lock admissions and moves take)
  setImmediate(async () => {
    try {
      await require("./beds").refreshListings(out.hostel);
      await wa("WA_TEMPLATE_BOOKING_ACCEPTED", out.studentPhone, [first(out.studentName), out.property, `Room ${out.bed.roomNumber}, bed ${out.bed.label}`, day(out.moveIn), out.bookingNo]);
    } catch (err) { console.error("Booking accepted follow-up (non-fatal):", err.message); }
  });
  return out;
}

/** What a cancellation refunds now: { mode: full|half|none, refund (₹), text } */
function cancelPreview(b, by = "student", now = new Date()) {
  let mode = "full";
  if (by === "student" && b.status === "accepted") {
    const cutoff = moment(b.moveIn).tz(TZ).startOf("day").subtract(Number(b.rule && b.rule.days) || 0, "days");
    mode = moment(now).tz(TZ).isAfter(cutoff) ? "none" : (b.rule && b.rule.after) || "full";
  }
  const plan = refundPlan(b, mode);
  return { mode, refund: plan.refund / 100, keep: (b.toOwnerPaise - plan.reverse) / 100 };
}
function refundPlan(b, mode) {
  if (mode === "full") return { refund: b.amountPaise, reverse: b.toOwnerPaise };
  if (mode === "half") { const refund = Math.round(b.amount * 100 / 2); return { refund, reverse: Math.min(refund, b.toOwnerPaise) }; }   // (the owner returns what the student gets back)
  return { refund: 0, reverse: 0 };
}

/**
 * Close a booking with its refund. kind: declined | cancelled | expired.
 * by: "owner" | "student" | "system"; mode: full | half | none (computed for students).
 */
async function close({ id, kind, by, byName = "", reason = "", mode = "full", ownerId = null, studentId = null, expectRefund = null }) {
  const q = { _id: id };
  if (ownerId) q.owner = ownerId;
  if (studentId) q.student = studentId;
  const b0 = await Booking().findOne(q, { _id: 1 }).lean();
  if (!b0) throw fail("missing", "Booking not found.");
  const out = await lockedBooking(b0._id, async () => {
    const b = await Booking().findById(b0._id).lean();
    const allowed = kind === "declined" || kind === "expired" ? ["requested"] : OPEN;
    if (!allowed.includes(b.status)) throw fail("state", "This booking can no longer be changed.");
    const m = by === "student" ? cancelPreview(b, "student").mode : mode;
    const plan = refundPlan(b, m);
    // The student is shown the refund before cancelling: if it changed meanwhile (the owner accepted), ask again.
    if (expectRefund !== null && expectRefund !== undefined && Number(expectRefund) !== plan.refund) throw fail("changed", "The booking changed a moment ago (the owner answered). Please check the refund and cancel again.");
    const text = kind === "declined" ? `Declined${reason ? ": " + reason : ""}` : kind === "expired" ? "No answer in 72 hours: cancelled" : `${by === "system" ? "Cancelled automatically" : "Cancelled by " + (by === "student" ? "the student" : "the owner")}${reason ? ": " + reason : ""}`;
    const r = await Booking().updateOne({ _id: b._id, status: b.status }, {
      $set: { status: kind, closedAt: new Date(), reason: String(reason || "").slice(0, 200), cancelledBy: by, decidedBy: byName || by,
        refund: { target: plan.refund, reverse: plan.reverse, status: plan.refund || plan.reverse ? "pending" : "done", tries: 0, error: "", at: null } },
      $push: { history: note(`${text} · refund ${inr(plan.refund / 100)}`, byName || by) },
    });
    if (!r.modifiedCount) throw fail("state", "This booking changed a moment ago. Please check it again.");
    return Booking().findById(b._id).lean();
  });
  // Money back now (and again by the 15-minute job if Razorpay could not be reached).
  try { await settle(out._id); } catch (err) { console.error("Booking refund (will retry):", PO.redact(err.message)); }
  let fresh = await Booking().findById(out._id).lean();
  // Nothing to refund (cancelled too close to move-in): what the owner keeps goes on to their bank now.
  if (fresh.refund && fresh.refund.status === "done" && !fresh.refund.reverse && fresh.toOwnerPaise > 0 && (!fresh.payout || fresh.payout.status !== "settled")) {
    try { await release(fresh); fresh = await Booking().findById(out._id).lean(); } catch (err) { console.error("Booking payout release (will retry):", PO.redact(err.message)); }
  }
  setImmediate(async () => {
    try {
      if (out.bed && out.bed.room) await require("./beds").refreshListings(out.hostel);
      const why = kind === "declined" ? (reason || "the PG could not take the booking") : kind === "expired" ? "the PG did not answer in time" : by === "student" ? "you cancelled it" : (reason || "the PG cancelled it");
      await wa("WA_TEMPLATE_BOOKING_CANCELLED", out.studentPhone, [first(out.studentName), out.property, why, inr(out.refund.target / 100), out.bookingNo]);
      if (by === "student") await notifyOwner(out, `Booking cancelled: ${out.studentName}`, `${out.roomType} · move in ${day(out.moveIn)}. Refund ${inr(out.refund.target / 100)}.`, "cancel");
    } catch (err) { console.error("Booking closed follow-up (non-fatal):", err.message); }
  });
  return fresh;
}

/* ── Razorpay: refunds, reversals, holds ────────────────────── */
async function transferOf(b) {
  if (TRF.test((b.payout && b.payout.transferId) || "")) return rzp.call("GET", `/v1/transfers/${b.payout.transferId}?expand[]=recipient_settlement`);
  if (!PAY.test(b.razorpayPaymentId || "")) return null;
  const list = await rzp.call("GET", `/v1/payments/${b.razorpayPaymentId}/transfers`);
  const items = (Array.isArray(list && list.items) ? list.items : []).filter(x => x && x.recipient === b.accountId).sort((a, c) => (Number(c.created_at) || 0) - (Number(a.created_at) || 0));
  return items.find(x => x.status !== "failed") || items[0] || null;
}
async function accountHold(ownerId) {
  const acc = await require("../models/payoutAccount").findOne({ owner: ownerId }, { hold: 1 }).lean();
  return !!(acc && acc.hold && acc.hold.on);
}
const payoutSet = t => {
  const st = OR.payoutStatusOf(t);
  const set = { "payout.transferId": t.id, "payout.status": st, "payout.checkedAt": new Date() };
  if (st === "settled") { const rs = t.recipient_settlement && typeof t.recipient_settlement === "object" ? t.recipient_settlement : null; set["payout.settledAt"] = rs && Number(rs.created_at) ? new Date(Number(rs.created_at) * 1000) : new Date(); }
  return set;
};

/** Do the refund of a closed booking: take back the owner's share, refund the student, release what the owner keeps. Idempotent. */
async function settle(id) {
  return lockedBooking(id, async () => {
    const b = await Booking().findById(id).lean();
    if (!b || !b.refund || b.refund.status !== "pending") return b;
    try {
      const t = await transferOf(b);
      const target = Number(b.refund.target) || 0, reverse = Number(b.refund.reverse) || 0;
      if (reverse > 0 && !t && PAY.test(b.razorpayPaymentId || "") && Date.now() - new Date(b.paidAt || b.createdAt) > 3600e3) {
        // An hour after paying Razorpay still shows no transfer to the owner: nothing to take back, the student is refunded.
        // (Sooner than that the transfer may just not be made yet: then this throws below and is tried again.)
        await Booking().updateOne({ _id: b._id }, { $push: { history: note("No transfer to the owner found: refunded without a reversal", "HostelNode") } });
      } else if (reverse > 0) {
        if (!t || !TRF.test(t.id || "")) throw new Error("The transfer to the owner is not made yet");
        const done = Number(t.amount_reversed) || 0;
        if (t.status !== "failed" && done < reverse) await rzp.call("POST", `/v1/transfers/${t.id}/reversals`, { amount: reverse - done, notes: { booking: b.bookingNo } });
      }
      if (target > 0) {
        const p = await rzp.call("GET", `/v1/payments/${b.razorpayPaymentId}`);
        const done = Number(p && p.amount_refunded) || 0;
        if (done < target) await rzp.call("POST", `/v1/payments/${b.razorpayPaymentId}/refund`, { amount: target - done, notes: { booking: b.bookingNo } });
      }
      // What the owner keeps (a partial or no refund) goes on to their bank.
      if (b.toOwnerPaise - reverse > 0 && t && t.on_hold && !(await accountHold(b.owner))) await rzp.call("PATCH", `/v1/transfers/${t.id}`, { on_hold: false });
      const t2 = t && TRF.test(t.id || "") ? await rzp.call("GET", `/v1/transfers/${t.id}`).catch(() => t) : null;
      await Booking().updateOne({ _id: b._id }, { $set: Object.assign({ "refund.status": "done", "refund.at": new Date(), "refund.error": "" }, t2 ? payoutSet(t2) : {}) });
    } catch (err) {
      const tries = (Number(b.refund.tries) || 0) + 1;
      await Booking().updateOne({ _id: b._id }, { $set: { "refund.tries": tries, "refund.error": PO.redact(err.message).slice(0, 200), "refund.status": tries >= MAX_TRIES ? "failed" : "pending" } });
      throw err;
    }
    return Booking().findById(id).lean();
  });
}

/** Release the held share to the owner (after move-in, or what they keep), unless HostelNode holds their payouts. */
async function release(b) {
  if (b.status === "cancelled" && b.toOwnerPaise - ((b.refund && b.refund.reverse) || 0) <= 0) return null;   // nothing of it is the owner's
  const t = await transferOf(b);
  if (!t || !TRF.test(t.id || "")) return null;
  if (t.on_hold && !(await accountHold(b.owner))) await rzp.call("PATCH", `/v1/transfers/${t.id}`, { on_hold: false });
  const t2 = await rzp.call("GET", `/v1/transfers/${t.id}?expand[]=recipient_settlement`).catch(() => t);
  await Booking().updateOne({ _id: b._id }, { $set: payoutSet(t2) });
  return t2;
}

/* ── Move-in: credit the booking amount ─────────────────────── */
/**
 * After Admit: the booking amount counts towards rent (a ledger payment with a receipt) or the deposit,
 * the booking is moved in, and the owner's share is released. Returns the booking.
 */
async function creditOnAdmit({ id, ownerId, memberId }) {
  const Member = require("../models/member");
  const P = require("./payments");
  const b0 = await Booking().findOne({ _id: id, owner: ownerId }, { _id: 1 }).lean();
  if (!b0) return null;
  const out = await lockedBooking(b0._id, async () => {
    const b = await Booking().findById(b0._id).lean();
    if (b.status !== "accepted") return b.status === "moved_in" ? b : null;
    const member = await Member.findOne({ _id: memberId, user: ownerId, hostel: b.hostel });
    // Only the student who booked: their mobile number, or admitted from this booking into its bed — in the booking's property.
    const inBookedBed = !!(member && b.bed && String(member.assignedRoom_id) === String(b.bed.room) && member.bedLabel === b.bed.label);
    if (!member || (OR.mobile10(member.mobileNo) !== OR.mobile10(b.studentPhone) && !inBookedBed)) return null;
    let paymentId = null;
    if (b.countsTowards === "rent") {
      const done = await P.recordPayment({
        ownerId, member, amount: b.amount, mode: OR.modeOf(b.method), reference: b.razorpayPaymentId, date: new Date(),
        note: `Booking ${b.bookingNo}, paid ${day(b.paidAt)}`,
        by: { id: b.student, name: b.studentName, role: "tenant" },
        extra: { tenantName: b.studentName, online: { orderId: b.razorpayOrderId, paymentId: b.razorpayPaymentId, method: b.method || "", total: b.total, booking: b._id },
          // (shown in the owner's Payouts with online rent; released to their bank just below)
          payout: { status: "pending", amount: b.toOwnerPaise / 100, gatewayFee: b.fee, commission: b.commission, feePaidBy: b.feePaidBy, accountId: b.accountId, transferId: (b.payout && b.payout.transferId) || undefined } },
      });
      paymentId = done.payment._id;
    } else {
      const m = await Member.findById(member._id, { depositPaid: 1, depositAmount: 1 }).lean();
      const paid = (Number(m.depositPaid) || 0) + b.amount;
      await Member.updateOne({ _id: member._id }, { $set: { depositPaid: paid, depositAmount: Math.max(Number(m.depositAmount) || 0, paid), depositMode: "Online (booking)", depositPaidAt: new Date() } });
    }
    await Booking().updateOne({ _id: b._id, status: "accepted" }, {
      $set: { status: "moved_in", member: member._id, payment: paymentId, movedInAt: new Date() },
      $push: { history: note(`Moved in · ${inr(b.amount)} credited to ${b.countsTowards === "rent" ? "rent" : "the deposit"}`) },
    });
    return Booking().findById(b._id).lean();
  });
  if (out && out.status === "moved_in") release(out).catch(err => console.error("Booking payout release (will retry):", PO.redact(err.message)));
  return out;
}

/* ── Every 15 minutes: reminders, no-answer, refunds, payouts ── */
async function tick(now = new Date()) {
  if (!enabled() && !PO.ready()) return { reminded: 0, expired: 0, refunds: 0, synced: 0 };
  const stats = { reminded: 0, expired: 0, refunds: 0, synced: 0 };
  const waiting = await Booking().find({ status: "requested", paidAt: { $lt: new Date(now.getTime() - 24 * 3600e3) } }).sort({ paidAt: 1 }).limit(200).lean();
  for (const b of waiting) {
    try {
      const age = (now - new Date(b.paidAt)) / 3600e3;
      if (age >= EXPIRE_H) { await close({ id: b._id, kind: "expired", by: "system", byName: "HostelNode", mode: "full" }); stats.expired++; continue; }
      const due = age >= ANSWER_H ? 2 : 1;
      if ((b.reminders || 0) < due) {
        const r = await Booking().updateOne({ _id: b._id, status: "requested", reminders: b.reminders || 0 }, { $set: { reminders: due } });
        if (!r.modifiedCount) continue;
        await notifyOwner(b, `Answer ${b.studentName}'s booking`, `${b.roomType} · move in ${day(b.moveIn)}. It is cancelled and refunded on ${dayTime(expiresAt(b))} if not answered.`, "remind" + due);
        const owner = await require("../models/owner").findById(b.owner, { phone: 1 }).lean();
        await wa("WA_TEMPLATE_BOOKING_REMINDER", owner && owner.phone, [b.studentName, b.property, dayTime(expiresAt(b))]);
        stats.reminded++;
      }
    } catch (err) { console.error("Booking reminder (non-fatal):", err.message); }
  }
  // Accepted bookings: admitted with the normal form (or the credit could not be saved at admission) → credited now;
  // a day after the move-in date without admission → the owner is asked to admit or mark "Didn't move in".
  const Member = require("../models/member");
  for (const b of await Booking().find({ status: "accepted", moveIn: { $lt: now } }).sort({ checkedAt: 1, moveIn: 1 }).limit(200).lean()) {
    try {
      await Booking().updateOne({ _id: b._id }, { $set: { checkedAt: now } });
      const m = await movedInTenant(b);
      if (m) { await creditOnAdmit({ id: b._id, ownerId: b.owner, memberId: m._id }); stats.synced++; continue; }
      if (now - new Date(b.moveIn) > 24 * 3600e3) await notifyOwner(b, `Did ${b.studentName} move in?`, `Booking ${b.bookingNo}, move-in ${day(b.moveIn)}. Admit them, or mark "Didn't move in" in Bookings.`, "movein");
    } catch (err) { console.error("Booking move-in check (non-fatal):", err.message); }
  }
  for (const b of await Booking().find({ "refund.status": "pending" }, { _id: 1 }).sort({ updatedAt: 1 }).limit(100).lean()) {
    try { await settle(b._id); stats.refunds++; } catch (err) { console.error("Booking refund retry (non-fatal):", PO.redact(err.message)); }
  }
  // The owner's share after move-in (or what they kept): released and followed to their bank.
  const keep = await Booking().find({ $or: [{ status: "moved_in" }, { status: "cancelled", "refund.status": "done" }], "payout.status": { $in: ["on_hold", "pending"] } }).sort({ "payout.checkedAt": 1 }).limit(100).lean();
  for (const b of keep) {
    if (b.status === "cancelled" && b.toOwnerPaise - ((b.refund && b.refund.reverse) || 0) <= 0) continue;
    try { await release(b); stats.synced++; } catch (err) { console.error("Booking payout check (non-fatal):", PO.redact(err.message)); }
  }
  return stats;
}

/** The tenant who moved in from this booking: living in its property with the booking's mobile number, admitted since it was accepted (or in the booked bed). */
async function movedInTenant(b) {
  const Member = require("../models/member");
  const list = await Member.find({ hostel: b.hostel, user: b.owner, mobileNo: { $in: OR.mobileVariants(b.studentPhone) }, ...LIVING }, { _id: 1, assignedRoom_id: 1, bedLabel: 1 }).lean();
  // (Admitted after they paid: when the tenant record was made, not the joining date the owner typed.)
  const since = moment(b.paidAt || b.createdAt).tz(TZ).startOf("day");
  return list.find(m => (b.bed && String(m.assignedRoom_id) === String(b.bed.room) && m.bedLabel === b.bed.label) || !moment(new mongoose.Types.ObjectId(String(m._id)).getTimestamp()).tz(TZ).isBefore(since)) || null;
}

/** HostelNode admin held or released an owner's payouts: follow it for their booking money already theirs. */
async function applyHold(ownerId, on) {
  const list = await Booking().find({ owner: ownerId, $or: [{ status: "moved_in" }, { status: "cancelled", "refund.status": "done" }], "payout.status": { $in: on ? ["pending"] : ["on_hold"] } }).lean();
  let done = 0, failed = 0;
  for (const b of list) {
    if (b.status === "cancelled" && b.toOwnerPaise - ((b.refund && b.refund.reverse) || 0) <= 0) continue;   // nothing of it is the owner's
    try {
      const t = await transferOf(b);
      if (!t || !TRF.test(t.id || "")) { failed++; continue; }
      await rzp.call("PATCH", `/v1/transfers/${t.id}`, { on_hold: !!on });
      await Booking().updateOne({ _id: b._id }, { $set: payoutSet(await rzp.call("GET", `/v1/transfers/${t.id}`)) });
      done++;
    } catch (err) { failed++; console.error("Booking hold change (non-fatal):", PO.redact(err.message)); }
  }
  return { done, failed };
}

/** The accepted booking holding this bed (other than exceptId), or null. */
async function bookedBed(roomId, label, exceptId = null) {
  if (!isId(String(roomId || "")) || !label) return null;
  const q = { status: "accepted", "bed.room": new mongoose.Types.ObjectId(String(roomId)), "bed.label": String(label).toUpperCase() };
  if (exceptId && isId(String(exceptId))) q._id = { $ne: new mongoose.Types.ObjectId(String(exceptId)) };
  return Booking().findOne(q, { studentName: 1, moveIn: 1, bookingNo: 1 }).lean();
}

/* ── Messages ───────────────────────────────────────────────── */
async function notifyOwner(b, title, body, key) {
  try {
    const col = mongoose.connection.collection("notifications");
    const dedupeKey = `booking:${b._id}:${key}`;
    if (await col.findOne({ user: new mongoose.Types.ObjectId(String(b.owner)), dedupeKey }, { projection: { _id: 1 } })) return;
    const now = new Date();
    await col.insertOne({ user: new mongoose.Types.ObjectId(String(b.owner)), userModel: "Owner", type: "PG_BOOKING", title: String(title).slice(0, 140), body: String(body).slice(0, 300),
      link: `/user/bookings?open=${b._id}`, dedupeKey, isRead: false, readAt: null, createdAt: now, updatedAt: now });
  } catch (err) { console.error("Booking notification (non-fatal):", err.message); }
}

/**
 * WhatsApp from HostelNode's number with an APPROVED template, only when its name is set in .env.
 * Templates (category Utility, language en) are listed in PROPERTY-OPERATIONS-PHASE-8.md. Never throws.
 */
async function wa(envName, phone, values) {
  try {
    const name = String(process.env[envName] || "").trim();
    if (!name || /^(off|0|false)$/i.test(name) || !process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return { sent: false, why: "off" };
    const mobile = OR.mobile10(phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    const lang = String(process.env[envName + "_LANG"] || "en").trim();
    const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || "-";
    const base = String(process.env.WA_API_BASE || "https://graph.facebook.com/v19.0").replace(/\/$/, "") + "/" + process.env.WA_PHONE_ID;
    const res = await fetch(base + "/messages", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + process.env.WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: "91" + mobile, type: "template",
        template: { name, language: { code: lang }, components: [{ type: "body", parameters: values.map(v => ({ type: "text", text: tidy(v) })) }] } }),
    });
    if (!res.ok) { let m = ""; try { m = (await res.json()).error.message; } catch { /* ignore */ } throw new Error(m || "WhatsApp answered " + res.status); }
    return { sent: true };
  } catch (err) {
    console.error("Booking WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

/* ── How a booking reads ────────────────────────────────────── */
const STATUS = {
  requested: { label: "Waiting for owner", tone: "warn" },
  accepted:  { label: "Accepted", tone: "ok" },
  moved_in:  { label: "Moved in", tone: "blue" },
  declined:  { label: "Declined", tone: "slate" },
  cancelled: { label: "Cancelled", tone: "slate" },
  expired:   { label: "No answer · cancelled", tone: "slate" },
};
function refundLine(b) {
  if (!b.refund || !b.refund.status) return "";
  const amt = inr((b.refund.target || 0) / 100);
  if (!b.refund.target) return "No refund";
  return b.refund.status === "done" ? `${amt} refunded${b.refund.at ? " on " + day(b.refund.at) : ""}` : b.refund.status === "failed" ? `${amt} refund needs HostelNode support` : `${amt} being refunded`;
}

module.exports = {
  enabled, ANSWER_H, EXPIRE_H, MAX_DAYS, MIN_AMOUNT, AFTER, STATUS, OPEN, inr, day, dayTime, settingsOf, amountFor, ruleText, freeByType, bookability,
  moveInRange, dateIn, kycOf, startOrder, fulfil, afterPaid, answerBy, expiresAt, bedOptions, accept, cancelPreview, refundPlan, close, settle, release,
  creditOnAdmit, tick, applyHold, notifyOwner, wa, refundLine, transferOf, bookedBed, movedInTenant,
};
