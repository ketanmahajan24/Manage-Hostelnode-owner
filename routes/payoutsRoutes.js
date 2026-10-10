/* ============================================================
   routes/payoutsRoutes.js  —  Property Operations Phase 6: owner bank payouts
   Mounted at /user in app.js.

     GET  /account/payouts                 Receive payments: status, bank account form, Payouts tab (?tab=payouts)
     POST /account/payouts                 submit / fix the details (business, PAN, bank, contact)
     POST /account/payouts/bank            change the bank account only
     POST /account/payouts/refresh         ask Razorpay for the latest status
     GET  /account/payouts/ifsc/:code      bank and branch for an IFSC (JSON)
     POST /account/payouts/online          Phase 7: online rent on/off for one property ("Online + cash" / "Cash only")

   Only the logged-in owner's own details. The full bank account number and
   PAN are sent to Razorpay and never saved or shown again.
============================================================ */
const express = require("express");
const router = express.Router();
const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const Hostel = require("../models/hostel");
const Payment = require("../models/payment");
const PayoutAccount = require("../models/payoutAccount");
const PayoutSettings = require("../models/payoutSettings");
const PO = require("../utils/payouts");
const T = require("../utils/tenants");

const on = (req, res, next) => (PO.enabled() ? next() : next("router"));   // HN_PAYOUTS=off → not found
const PAGE = "/user/account/payouts";

async function render(req, res, { values = null, errors = {}, form = null, notice = null } = {}) {
  const user = await Owner.findById(req.user.id);
  let rec = await PayoutAccount.findOne({ owner: req.user.id }).lean();
  if (rec && !form) rec = await PO.refresh(rec);   // (at most once a minute)
  const tab = req.query.tab === "payouts" ? "payouts" : "bank";
  // Made with test keys and HostelNode now uses live keys (or the other way round): filled in again.
  // (also an account id linked by support: the owner submits once more so it is confirmed as theirs)
  const stale = PO.staleMode(rec) || !!(rec && rec.accountId && !rec.mode);
  if (stale && !notice) notice = { kind: "bad", text: rec && rec.accountId && !rec.mode ? "Please submit your details once more to finish setting up payouts." : PO.mode() === "live" ? "Online payouts have moved to live mode. Please fill in your details again so Razorpay can set up real payouts." : "HostelNode's Razorpay account has changed. Please fill in your details again." };
  // Which form to show: the full one (first time, or "Fix details"), the bank-only one ("Change bank account"), or none.
  const status = rec && !stale ? rec.status : "draft";
  if (!form) form = status === "draft" || !rec.accountId || !rec.productId ? "full" : req.query.edit === "1" ? "full" : req.query.bank === "1" ? "bank" : null;
  if (form === "bank" && status !== "active" && status !== "needs_attention" && status !== "under_review") form = "full";
  if (!values) {
    const hostel = res.locals.selectedHostel || (await Hostel.findOne({ owner: req.user.id }, { city: 1, state: 1 }).lean()) || {};
    values = rec && rec.legalName ? {
      businessType: rec.businessType, legalName: rec.legalName, contactName: rec.contactName, email: rec.email, phone: rec.phone,
      street: rec.street, city: rec.city, state: rec.state, pin: rec.pin, beneficiaryName: rec.beneficiaryName, ifsc: rec.ifsc,
    } : { businessType: "individual", legalName: "", contactName: user && user.name || "", email: user && user.email || "", phone: String(user && user.phone || "").replace(/\D/g, "").slice(-10), city: hostel.city || "", state: PO.STATES.includes(hostel.state) ? hostel.state : "", beneficiaryName: "" };
  }
  let payouts = { list: [], received: 0, count: 0 };
  if (tab === "payouts") {
    // Online rent paid by tenants (from Phase 7). Each has what went to the owner's bank.
    // (Phase 7: a payment refunded to the tenant stays listed, marked, so the owner sees where its payout went.)
    const list = await Payment.find({ user: req.user.id, "recordedBy.role": "tenant" }).sort({ paymentDate: -1 }).limit(200).lean();
    const kept = list.filter(p => !p.cancelledAt);
    payouts = { list, received: kept.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0), count: kept.length };
  }
  const settings = await PayoutSettings.read();
  // Phase 7: the per-property switch "Online + cash / Cash only".
  const properties = status === "active" ? await Hostel.find({ owner: req.user.id }, { hostelName: 1, onlineRent: 1 }).sort({ createdAt: 1 }).lean() : [];
  res.set("Cache-Control", "no-store");
  res.render("account/payouts.ejs", {
    user, rec, status, S: PO.STATUS[status], tab, form, values, errors, notice: notice || flash(req), TYPES: PO.TYPES, STATES: PO.STATES,
    ready: PO.ready(), mode: PO.mode(), payouts, fees: settings, T, fixed: !!(rec && rec.accountId && !stale),   // email and business type can no longer change
    properties,
  });
}
const NOTES = {
  submitted: { kind: "ok", text: "Sent to Razorpay. You'll see the result here, usually within 1–2 working days." },
  bank: { kind: "ok", text: "New bank account sent to Razorpay for checking. Online rent is paid out again once it is approved." },
  checked: { kind: "ok", text: "Status checked with Razorpay." },
  online_on: { kind: "ok", text: "Online rent switched on for that property. Its tenants see “Pay rent” in My PG." },
  online_off: { kind: "ok", text: "That property is cash only now. Its tenants pay you directly." },
};
const flash = req => NOTES[req.query.msg] || null;

router.get("/account/payouts", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  try { await render(req, res); }
  catch (err) { console.error("Receive payments page error:", err.message); res.status(500).send("Something went wrong. Please try again."); }
});

async function post(req, res, bankOnly) {
  const body = Object.assign({}, req.body || {});
  // Already with Razorpay: the email and business type stay as they were.
  const had = await PayoutAccount.findOne({ owner: req.user.id }).lean();
  if (had && had.accountId && !PO.staleMode(had)) { body.email = had.email; body.businessType = had.businessType; }
  const { values, errors } = PO.validate(body, { bankOnly });
  const form = bankOnly ? "bank" : "full";
  if (!PO.ready()) return render(req, res, { values, errors, form, notice: { kind: "bad", text: "Online payouts are not switched on yet. Please try again later." } });
  if (Object.keys(errors).length) {
    if (bankOnly) {   // keep the rest of what is shown
      const rec = await PayoutAccount.findOne({ owner: req.user.id }).lean();
      Object.assign(values, rec ? { businessType: rec.businessType, legalName: rec.legalName } : {});
    }
    return render(req, res, { values, errors, form, notice: { kind: "bad", text: "Please check the highlighted details." } });
  }
  try {
    const owner = await Owner.findById(req.user.id, { name: 1 }).lean();
    await PO.submit(req.user.id, values, { bankOnly, byName: (owner && owner.name) || "owner" });
    res.redirect(PAGE + "?msg=" + (bankOnly ? "bank" : "submitted"));
  } catch (err) {
    console.error("Payout submit error:", PO.redact(err.message));
    render(req, res, { values, errors: {}, form, notice: { kind: "bad", text: err.code === "razorpay" || err.code === "busy" || err.code === "not_set_up" || err.code === "not_ready" ? err.message : "That could not be sent to Razorpay. Please try again." } });
  }
}
router.post("/account/payouts", jwtAuthMiddleware, on, attachHostel, (req, res) => post(req, res, false));
router.post("/account/payouts/bank", jwtAuthMiddleware, on, attachHostel, (req, res) => post(req, res, true));

router.post("/account/payouts/refresh", jwtAuthMiddleware, on, async (req, res) => {
  try {
    const rec = await PayoutAccount.findOne({ owner: req.user.id }).lean();
    if (rec) await PO.refresh(rec, { force: !rec.lastCheckedAt || Date.now() - new Date(rec.lastCheckedAt) > 3e3 });   // (a pressed button asks Razorpay, at most every 3 seconds)
    res.redirect(PAGE + "?msg=checked");
  } catch (err) {
    console.error("Payout refresh error:", err.message);
    res.redirect(PAGE);
  }
});

// Phase 7: online rent on or off for one of this owner's properties.
router.post("/account/payouts/online", jwtAuthMiddleware, on, async (req, res) => {
  try {
    const id = String((req.body && req.body.hostel) || "");
    const want = String(req.body && req.body.on) === "1";
    if (!/^[0-9a-f]{24}$/i.test(id)) return res.redirect(PAGE);
    const r = await Hostel.updateOne({ _id: id, owner: req.user.id }, { $set: { onlineRent: want } });
    res.redirect(PAGE + (r.matchedCount ? "?msg=" + (want ? "online_on" : "online_off") : ""));
  } catch (err) {
    console.error("Online rent switch error:", err.message);
    res.redirect(PAGE);
  }
});

router.get("/account/payouts/ifsc/:code", jwtAuthMiddleware, on, async (req, res) => {
  res.set("Cache-Control", "private, max-age=3600");
  const out = await PO.ifscLookup(req.params.code).catch(() => null);
  res.json(out ? { ok: true, bank: out.bank, branch: out.branch, city: out.city } : { ok: false });
});

module.exports = router;
