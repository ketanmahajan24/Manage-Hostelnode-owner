/* ============================================================
   routes/paymentsRoutes.js  —  Property Operations Phase 5: rent ledger and cash payments
   Mounted at /user in app.js, before userRoutes.js (whose old payment pages it replaces).

     GET  /payments                        Payments: this month's numbers; Due now / Collected
     GET  /payments/upcoming               Payments: Upcoming (next 7 days)  — plan feature "Dues & Upcoming"
     GET  /dues                            Dues: most overdue first           — plan feature "Dues & Upcoming"
     GET  /tenants/:id/collect             Collect payment (a panel; ?partial=1 for the slide-in drawer)
     POST /tenants/:id/payments            record a payment (cash, UPI to owner, bank transfer)
     POST /tenants/:id/charges             add an extra charge to a month
     POST /tenants/:id/entries/:pid/cancel cancel a wrong entry (with a reason; kept, crossed out)
     GET  /tenants/:id/statement.pdf       the tenant's statement
     GET  /payments/:pid/receipt.pdf       one payment's receipt

   Old addresses (Collect Payment, Upcoming, Dues, Add payment, receipt, payment history)
   open the new pages. HN_LEDGER=off in .env shows the old pages instead.
   Every query is limited to the logged-in owner's own tenants.
============================================================ */

const express = require("express");
const router = express.Router();
const moment = require("moment-timezone");

const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const Hostel = require("../models/hostel");
const Member = require("../models/member");
const Payment = require("../models/payment");
const { TZ, NOT_REMOVED, LIVING, isId, escapeRegex, nextDueDate, dueAnchor } = require("../utils/tenantOps");
const { tenantRent } = require("../utils/beds");
const T = require("../utils/tenants");
const L = require("../utils/ledger");
const P = require("../utils/payments");
const PDF = require("../utils/ledgerPdf");

const clean = P.clean;
function moneyIn(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}
const todayIST = () => moment().tz(TZ).startOf("day");
function dateIn(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const m = moment.tz(s, "YYYY-MM-DD", true, TZ);
  return m.isValid() ? m.toDate() : null;
}
const page = id => `/user/tenants/${id}`;
const withParam = (url, k, v) => `${url}${url.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;
const back = (res, url, msg, extra = {}) => { let u = withParam(url, "msg", msg); for (const [k, v] of Object.entries(extra)) u = withParam(u, k, v); res.redirect(u); };
const fail = (res, url, msg) => res.redirect(withParam(url, "err", msg));
const flash = req => ({ msg: clean(req.query.msg || "", 240), err: clean(req.query.err || "", 240) });
// Where to go back to after an action: only our own pages (no other sites, no odd addresses).
function backTo(req, fallback) {
  const raw = String(req.body.back || req.query.back || "");
  if (!/^\/user\/(payments(\/upcoming)?|dues|tenants\/[0-9a-f]{24})(\?[A-Za-z0-9=&%._+-]*)?$/.test(raw)) return fallback;
  return raw.replace(/([?&])(msg|err|paid)=[^&]*/g, "$1").replace(/[?&]+$/, "").replace(/\?&+/, "?");
}
const on = (req, res, next) => (P.ledgerOn() ? next() : next("router"));   // HN_LEDGER=off → the old pages
const needHostel = (req, res, next) => (res.locals.selectedHostel && res.locals.selectedHostel._id ? next() : res.redirect("/user"));
const monthKey = v => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || "")) ? String(v) : moment().tz(TZ).format("YYYY-MM"));

// One of this owner's tenants (not removed), payments populated.
async function myTenant(req, id) {
  if (!isId(String(id || ""))) return null;
  return Member.findOne({ _id: id, user: req.user.id, ...NOT_REMOVED }).populate("payments");
}

/* ── old addresses → new pages ─────────────────────────────── */
router.get("/allfeesrecords", jwtAuthMiddleware, on, (req, res) => res.redirect("/user/payments"));
router.post("/searchfeesrecords", jwtAuthMiddleware, on, (req, res) => res.redirect("/user/payments?q=" + encodeURIComponent(clean(req.body.searchQuery || "", 60))));
router.get("/upcomingPayments", jwtAuthMiddleware, on, (req, res) => res.redirect("/user/payments/upcoming"));
router.get("/deureports", jwtAuthMiddleware, on, (req, res) => res.redirect("/user/dues"));
router.get("/members/:id/addpayment", jwtAuthMiddleware, on, (req, res) => res.redirect(isId(req.params.id) ? `/user/tenants/${req.params.id}/collect` : "/user/payments"));
router.get("/payment-history/:id", jwtAuthMiddleware, on, (req, res) => res.redirect(isId(req.params.id) ? `/user/tenants/${req.params.id}?tab=payments` : "/user/payments"));
router.get("/payment-receipt/:pid", jwtAuthMiddleware, on, (req, res) => res.redirect(isId(req.params.pid) ? `/user/payments/${req.params.pid}/receipt.pdf` : "/user/payments"));

/* ── what the Payments pages show, for one property ───────── */
async function propertyMoney(ownerId, hostelId, key, now = new Date()) {
  const members = await Member.find({ user: ownerId, hostel: hostelId, ...NOT_REMOVED }).populate("payments");
  const today = moment(now).tz(TZ).startOf("day");
  const mStart = moment.tz(key + "-01", "YYYY-MM-DD", TZ), mEnd = mStart.clone().add(1, "month");
  const rows = [];
  let expected = 0, expectedTenants = 0, collected = 0;
  const paidBy = new Set(), collectedList = [];
  for (const m of members) {
    const lg = L.ledgerOf(m, now);
    const mo = lg.months.find(x => x.key === key);
    const exp = mo ? mo.charges.filter(c => c.kind !== "refund").reduce((s, c) => s + c.amount, 0) : 0;
    if (exp > 0) { expected += exp; expectedTenants++; }
    for (const p of (m.payments || [])) {
      if (!p || typeof p !== "object" || !(Number(p.amountPaid) > 0) || L.kindOf(p) !== "payment") continue;
      const d = moment(p.paymentDate).tz(TZ);
      if (d.isBefore(mStart) || !d.isBefore(mEnd)) continue;
      if (!p.cancelledAt) { collected += Number(p.amountPaid); paidBy.add(String(m._id)); }
      collectedList.push({ m, p });
    }
    rows.push({ m, lg });
  }
  const dueRows = rows.filter(r => r.lg.due > 0 && !r.lg.notYetDue);
  const overdue = dueRows.filter(r => r.lg.daysLate > 0), dueToday = dueRows.filter(r => r.lg.daysLate === 0);
  collectedList.sort((a, b) => new Date(b.p.paymentDate) - new Date(a.p.paymentDate) || String(b.p._id).localeCompare(String(a.p._id)));
  return {
    rows, members, collectedList, dueRows,
    stats: {
      expected, expectedTenants, collected, paidTenants: paidBy.size,
      pct: expected > 0 ? Math.min(100, Math.round((collected / expected) * 100)) : 0,
      dueToday: dueToday.reduce((s, r) => s + r.lg.due, 0), dueTodayN: dueToday.length,
      overdue: overdue.reduce((s, r) => s + r.lg.due, 0), overdueN: overdue.length,
      dueAll: dueRows.reduce((s, r) => s + r.lg.due, 0),
    },
  };
}
const matches = (m, q) => {
  if (!q) return true;
  const re = new RegExp(escapeRegex(q), "i"), digits = q.replace(/\D/g, "");
  return re.test(m.name || "") || re.test(String(m.assignedRoom || "")) || (digits.length >= 3 && String(m.mobileNo || "").includes(digits));
};
const roomOf = m => (m.leftDate ? "Moved out " + T.day(m.leftDate) : [m.assignedRoom || "—", m.bedLabel].filter(Boolean).join(" · "));
const row = r => ({
  id: String(r.m._id), name: r.m.name, mobile: r.m.mobileNo, masked: T.maskMobile(r.m.mobileNo), room: roomOf(r.m), out: !!r.m.leftDate,
  tone: T.toneOf(r.m._id), initials: T.initials(r.m.name), due: r.lg.due, dueFor: r.m.leftDate && r.lg.owing.every(o => o.key >= T.ymd(r.m.leftDate).slice(0, 7)) ? "Move-out balance" : r.lg.dueFor,
  daysLate: r.lg.daysLate, monthsOwed: r.lg.monthsOwed, status: r.m.leftDate ? { label: "Moved out", tone: "slate" } : (r.lg.owing[0] || {}).status || { label: "Due", tone: "warn" },
});
function reminderLink(m, lg, property) {
  const first = String(m.name || "").trim().split(/\s+/)[0] || "";
  const text = `Hi ${first}, this is a reminder from ${property || "your PG"}: ${T.inr(lg.due)} is due${lg.dueFor ? " (" + lg.dueFor + ")" : ""}. Please pay at the earliest. Thank you.`;
  return `https://wa.me/91${String(m.mobileNo || "").replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(text)}`;
}

async function renderHome(req, res, tab) {
  const user = await Owner.findById(req.user.id);
  const key = monthKey(req.query.month);
  const q = clean(req.query.q || "", 60);
  const hostel = res.locals.selectedHostel;
  const data = await propertyMoney(req.user.id, hostel._id, key);
  const cur = moment().tz(TZ).format("YYYY-MM");
  let list = [];
  if (tab === "due") {
    list = data.dueRows.filter(r => matches(r.m, q)).sort((a, b) => b.lg.daysLate - a.lg.daysLate || b.lg.due - a.lg.due)
      .map(r => Object.assign(row(r), { remind: reminderLink(r.m, r.lg, hostel.hostelName) }));
  } else if (tab === "upcoming") {
    const today = todayIST(), last = today.clone().add(7, "days");
    for (const r of data.rows) {
      if (r.m.leftDate || !matches(r.m, q)) continue;
      const room = r.m.assignedRoom_id ? await require("../models/room").findById(r.m.assignedRoom_id, { room_fees: 1, beds: 1 }).lean() : null;
      const rent = room ? tenantRent(r.m, room) : 0;
      // A charge already made for a coming day (a new tenant's first rent), or the next rent day.
      const soon = r.lg.owing.find(o => o.status.key === "upcoming");
      const next = nextDueDate(dueAnchor(r.m), today.clone().add(1, "day").toDate());
      if (soon) {
        const mo = r.lg.months.find(x => x.key === soon.key);
        if (mo && mo.dueOn && !moment(mo.dueOn).tz(TZ).isAfter(last)) list.push(Object.assign(row(r), { on: mo.dueOn, amount: soon.amount, covered: false }));
      } else if (next && !next.isAfter(last) && rent > 0 && !(r.m.leavingDate && !moment(r.m.leavingDate).tz(TZ).isAfter(next))) {
        list.push(Object.assign(row(r), { on: next.toDate(), amount: rent, covered: r.lg.advance >= rent, advance: r.lg.advance }));
      }
    }
    list.sort((a, b) => new Date(a.on) - new Date(b.on));
  } else {
    list = data.collectedList.filter(x => matches(x.m, q)).map(x => ({
      id: String(x.m._id), pid: String(x.p._id), name: x.m.name, room: roomOf(x.m), tone: T.toneOf(x.m._id), initials: T.initials(x.m.name),
      amount: Number(x.p.amountPaid) || 0, mode: x.p.paymentMode || "", reference: x.p.reference || "", on: x.p.paymentDate, receiptNo: x.p.receiptNo || "",
      by: x.p.recordedBy && x.p.recordedBy.role === "tenant" ? "paid online by tenant" : x.p.recordedBy && x.p.recordedBy.id ? (String(x.p.recordedBy.id) === String(req.user.id) ? "you" : x.p.recordedBy.name || "") : "",   // (Phase 7: online)
      cancelled: !!x.p.cancelledAt, cancelReason: x.p.cancelReason || "",
    }));
  }
  res.set("Cache-Control", "no-store");
  res.render("payments5/home.ejs", {
    user, tab, key, cur, q, list, stats: data.stats, hostel, T, flash: flash(req), paid: await paidToast(req),
    monthLabel: L.monthLabel(key), prevShort: moment.tz(key + "-01", TZ).subtract(1, "month").format("MMM"), nextShort: moment.tz(key + "-01", TZ).add(1, "month").format("MMM"), prev: moment.tz(key + "-01", TZ).subtract(1, "month").format("YYYY-MM"), next: key < cur ? moment.tz(key + "-01", TZ).add(1, "month").format("YYYY-MM") : "",
    counts: { due: data.dueRows.length, collected: data.collectedList.filter(x => !x.p.cancelledAt).length },
    self: req.originalUrl,
  });
}
router.get("/payments", jwtAuthMiddleware, on, attachHostel, needHostel, async (req, res) => {
  try { await renderHome(req, res, req.query.tab === "collected" ? "collected" : "due"); }
  catch (err) { console.error("Payments page error:", err.message); res.status(500).send("Something went wrong. Please try again."); }
});
router.get("/payments/upcoming", jwtAuthMiddleware, on, attachHostel, needHostel, async (req, res) => {
  try { await renderHome(req, res, "upcoming"); }
  catch (err) { console.error("Upcoming page error:", err.message); res.status(500).send("Something went wrong. Please try again."); }
});

router.get("/dues", jwtAuthMiddleware, on, attachHostel, needHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    const hostel = res.locals.selectedHostel;
    const sort = req.query.sort === "amount" ? "amount" : "overdue";
    const q = clean(req.query.q || "", 60);
    const data = await propertyMoney(req.user.id, hostel._id, moment().tz(TZ).format("YYYY-MM"));
    const list = data.rows.filter(r => r.lg.due > 0 && !r.lg.notYetDue && matches(r.m, q))   // (rent not due yet: in Upcoming)
      .sort(sort === "amount" ? (a, b) => b.lg.due - a.lg.due : (a, b) => b.lg.daysLate - a.lg.daysLate || b.lg.due - a.lg.due)
      .map(r => Object.assign(row(r), { remind: reminderLink(r.m, r.lg, hostel.hostelName), email: r.m.email || "" }));
    // Phase 9: when each tenant was last reminded, and who "Send reminder" (from HostelNode) can reach.
    let reminders = { any: false };
    try {
      const RR = require("../utils/rentReminders");
      reminders = RR.channels();
      const last = await RR.lastReminders(list.map(x => x.id));
      const can = await RR.sendable(req.user.id, list.map(x => ({ id: x.id, hostelId: String(hostel._id), mobile: x.mobile, email: x.email, out: x.out, daysLate: x.daysLate })));
      for (const x of list) { x.reminded = RR.lastText(last.get(x.id)); x.canSend = can.has(x.id); }
    } catch (e) { console.error("Dues reminders (non-fatal):", e.message); }
    res.set("Cache-Control", "no-store");
    res.render("payments5/dues.ejs", { user, hostel, list, sort, q, total: list.reduce((s, x) => s + x.due, 0), T, flash: flash(req), paid: await paidToast(req), self: req.originalUrl, reminders });
  } catch (err) {
    console.error("Dues page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

// After recording: the toast with "View receipt" and "Undo" (only for a payment of this owner's, still standing).
async function paidToast(req) {
  const pid = String(req.query.paid || "");
  if (!isId(pid)) return null;
  const p = await Payment.findOne({ _id: pid, user: req.user.id }).lean();
  if (!p || p.cancelledAt) return null;
  const m = await Member.findOne({ _id: p.memberId, user: req.user.id }, { _id: 1 }).lean();
  if (!m) return null;
  return { pid, memberId: String(m._id), undo: Date.now() - new Date(p._id.getTimestamp()) < 10 * 60e3 };
}

/* ── Collect payment ──────────────────────────────────────── */
router.get("/tenants/:id/collect", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  try {
    const m = await myTenant(req, req.params.id);
    if (!m) return res.status(404).send("Tenant not found.");
    const lg = L.ledgerOf(m);
    const user = await Owner.findById(req.user.id, { name: 1 }).lean();
    const v = { m, lg, T, today: T.ymd(new Date()), back: backTo(req, page(m._id) + "?tab=payments"), ownerName: (user && user.name) || "", flash: flash(req), waOn: PDF.receiptOn(), partial: req.query.partial === "1" };
    res.set("Cache-Control", "no-store");
    if (v.partial) return res.render("payments5/_collectPanel.ejs", v);
    res.render("payments5/collect.ejs", Object.assign(v, { user: await Owner.findById(req.user.id) }));
  } catch (err) {
    console.error("Collect page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

const MODES = L.MODES;
async function recordFromForm(req, res, m, fields, backUrl) {
  const amount = moneyIn(fields.amount);
  const mode = MODES[fields.mode];
  const errUrl = `/user/tenants/${m._id}/collect?back=${encodeURIComponent(backUrl)}`;
  if (amount === null || amount <= 0) return fail(res, errUrl, "Enter the amount received.");
  if (!mode) return fail(res, errUrl, "Choose how it was paid: cash, UPI or bank transfer.");
  let date = fields.date ? dateIn(fields.date) : todayIST().toDate();
  if (!date) return fail(res, errUrl, "Enter the date it was received.");
  if (moment(date).tz(TZ).isAfter(todayIST())) return fail(res, errUrl, "The date received cannot be in the future.");
  if (moment(date).tz(TZ).isBefore(moment.tz("2000-01-01", TZ))) return fail(res, errUrl, "Check the date received.");
  // Today: the time it was recorded (so payments on one day keep their order). Another day: that day.
  if (moment(date).tz(TZ).isSame(todayIST(), "day")) date = new Date();
  const reference = clean(fields.reference || "", 60), note = clean(fields.note || "", 200);
  const { payment, dup } = await P.recordPayment({ ownerId: req.user.id, member: m, amount, mode, reference, date, note });
  let sent = null;
  if (!dup && fields.sendWa && PDF.receiptOn()) {
    const fresh = await Member.findById(m._id).populate("payments");
    const r = await P.receiptFor(req.user.id, fresh, payment);
    sent = await PDF.sendReceiptWhatsApp({ phone: m.mobileNo, tenantName: m.name, property: r.property, amount: T.inr(amount), mode, date: r.date, forText: P.forText(r.applied), receiptNo: r.receiptNo, pdf: PDF.buildReceiptPdf(r) });
  }
  const msg = dup ? `That payment was already recorded (receipt ${payment.receiptNo || ""}).`
    : `${T.inr(amount)} recorded · receipt ${payment.receiptNo}${sent ? (sent.sent ? " sent on WhatsApp" : " (not sent on WhatsApp: " + sent.why + ")") : ""}`;
  back(res, backUrl, msg, { paid: String(payment._id) });
}

router.post("/tenants/:id/payments", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  const m = await myTenant(req, req.params.id).catch(() => null);
  if (!m) return res.status(404).send("Tenant not found.");
  const backUrl = backTo(req, page(m._id) + "?tab=payments");
  try {
    await recordFromForm(req, res, m, { amount: req.body.amount, mode: req.body.mode, date: req.body.date, reference: req.body.reference, note: req.body.note, sendWa: req.body.sendWa === "1" }, backUrl);
  } catch (err) {
    console.error("Record payment error:", err.message);
    fail(res, `/user/tenants/${m._id}/collect?back=${encodeURIComponent(backUrl)}`, err.code === "busy" ? "Someone else is saving a payment for this tenant. Please try again." : "The payment could not be saved. Please try again.");
  }
});

// The old "Add payment" form (a page still open from before the update): recorded the new way.
router.post("/addpayment/:id", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  const m = await myTenant(req, req.params.id).catch(() => null);
  if (!m) return res.status(404).send("Member not found.");
  try {
    const p = req.body.payment || {};
    const said = clean(p.paymentMode || "", 30);
    const modeKey = /upi/i.test(said) ? "upi" : /bank|neft|imps|rtgs|transfer/i.test(said) ? "bank" : said ? "cash" : "";
    const date = p.paymentDate && !isNaN(new Date(p.paymentDate)) ? moment(new Date(p.paymentDate)).tz(TZ).format("YYYY-MM-DD") : "";
    // (Card, cheque…: recorded as cash, with what was chosen kept in the note.)
    const note = modeKey === "cash" && !/cash/i.test(said) ? "Paid by " + said : "";
    await recordFromForm(req, res, m, { amount: p.amountPaid, mode: modeKey, date, reference: "", note }, page(m._id) + "?tab=payments");
  } catch (err) {
    console.error("addpayment (old form) error:", err.message);
    res.status(500).send("The payment could not be saved. Please try again.");
  }
});

/* ── Extra charges ────────────────────────────────────────── */
router.post("/tenants/:id/charges", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  try {
    const m = await myTenant(req, req.params.id);
    if (!m) return res.status(404).send("Tenant not found.");
    const backUrl = backTo(req, page(m._id) + "?tab=payments");
    if (m.leftDate) return fail(res, backUrl, `${m.name} has moved out. Add anything they still owe at move-out (deductions).`);
    const category = L.CATEGORIES[req.body.category] || req.body.category === "rent" ? req.body.category : "";
    const amount = moneyIn(req.body.amount);
    const months = L.chargeMonths(m);
    const month = months.some(x => x.key === req.body.month) ? req.body.month : "";
    const note = clean(req.body.note || "", 120);
    if (!category) return fail(res, backUrl, "Choose what the charge is for.");
    if (amount === null || amount <= 0) return fail(res, backUrl, "Enter the amount of the charge.");
    if (!month) return fail(res, backUrl, "Choose the month the charge is for.");
    if (category === "other" && !note) return fail(res, backUrl, "Say what the charge is for (note).");
    const { dup, rentExists } = await P.addCharge({ ownerId: req.user.id, member: m, category, amount, month, note });
    if (rentExists) return fail(res, backUrl, `${L.monthLabel(month)} already has rent of ${T.inr(rentExists.roomFees)}. To change it, cancel that entry first (with a reason), then add the right amount.`);
    const label = category === "rent" ? "Rent" : L.CATEGORIES[category].label;
    if (dup) return back(res, backUrl, `That charge was already added.`);
    await T.logEvent(req, m, "charge", `${label} ${T.inr(amount)} added to ${L.monthLabel(month)}`, note);
    back(res, backUrl, `${label} ${T.inr(amount)} added to ${L.monthLabel(month)}.`);
  } catch (err) {
    console.error("Add charge error:", err.message);
    res.status(500).send("The charge could not be saved. Please try again.");
  }
});

/* ── Cancel an entry ──────────────────────────────────────── */
router.post("/tenants/:id/entries/:pid/cancel", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  try {
    const m = await myTenant(req, req.params.id);
    if (!m) return res.status(404).send("Tenant not found.");
    const backUrl = backTo(req, page(m._id) + "?tab=payments");
    const reason = clean(req.body.reason || "", 200);
    if (reason.length < 3) return fail(res, backUrl, "Say why the entry is cancelled (it is kept in History).");
    if (!isId(String(req.params.pid))) return fail(res, backUrl, "That entry was not found.");
    const e = await P.cancelEntry({ ownerId: req.user.id, member: m, entryId: req.params.pid, reason });
    if (!e) return fail(res, backUrl, "That entry cannot be cancelled (already cancelled, or part of a move-out settlement — undo the move-out instead).");
    const what = L.isPayment(e) ? `Payment of ${T.inr(e.amountPaid)}${e.paymentMode ? " · " + e.paymentMode : ""}${e.receiptNo ? " (" + e.receiptNo + ")" : ""}` : `${L.chargeLabel(e)} ${T.inr(e.roomFees)}`;
    await T.logEvent(req, m, "cancel", `${what} cancelled`, reason);
    back(res, backUrl, `${what} cancelled.`);
  } catch (err) {
    console.error("Cancel entry error:", err.message);
    res.status(500).send("That could not be done. Please try again.");
  }
});

/* ── PDFs ─────────────────────────────────────────────────── */
router.get("/payments/:pid/receipt.pdf", jwtAuthMiddleware, async (req, res) => {
  try {
    if (!isId(String(req.params.pid))) return res.status(404).send("Receipt not found.");
    const p = await Payment.findById(req.params.pid).lean();
    if (!p || !(Number(p.amountPaid) > 0)) return res.status(404).send("Receipt not found.");
    const m = await Member.findOne({ _id: p.memberId, user: req.user.id }).populate("payments");
    if (!m) return res.status(404).send("Receipt not found.");
    const r = await P.receiptFor(req.user.id, m, p);
    const pdf = PDF.buildReceiptPdf(r);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Receipt-${r.receiptNo.replace(/[^A-Za-z0-9-]/g, "")}.pdf"`, "Cache-Control": "private, no-store" });
    res.send(pdf);
  } catch (err) {
    console.error("Receipt PDF error:", err.message);
    res.status(500).send("The receipt could not be made. Please try again.");
  }
});

router.get("/tenants/:id/statement.pdf", jwtAuthMiddleware, async (req, res) => {
  try {
    const m = await myTenant(req, req.params.id);
    if (!m) return res.status(404).send("Tenant not found.");
    const s = await P.statementFor(req.user.id, m, req.user.id);
    const pdf = PDF.buildStatementPdf(s);
    const name = String(m.name || "tenant").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Statement-${name}.pdf"`, "Cache-Control": "private, no-store" });
    res.send(pdf);
  } catch (err) {
    console.error("Statement PDF error:", err.message);
    res.status(500).send("The statement could not be made. Please try again.");
  }
});

module.exports = router;
module.exports.paidToast = paidToast;
