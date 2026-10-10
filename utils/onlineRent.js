/* ============================================================
   utils/onlineRent.js  —  Property Operations Phase 7: rent paid online
   SHARED: identical in the owner dashboard and hostelnode.com.

   A tenant pays rent from My PG on hostelnode.com. The money goes to
   HostelNode's Razorpay account, and Razorpay Route sends the owner's
   share straight to the owner's bank (their linked account, Phase 6).

   Rules that keep money safe (the same as plan payments):
   • Every amount is worked out here, on the server, from the ledger and
     the fees set in admin. The browser only says how much rent to pay,
     and that is checked against what is due.
   • A payment is recorded only after Razorpay's signature checks out
     (the tenant's browser) or Razorpay calls the webhook itself.
   • One Razorpay payment makes one ledger entry, however many times we
     hear about it (a lock per order, and the payment id is checked).
   • The Route transfer is part of the Razorpay order, so Razorpay makes
     it exactly once, when the payment is captured.

   Switch: HN_ONLINE_RENT=off in .env (either site) stops new online
   payments; everything already paid stays.
============================================================ */

const crypto = require("crypto");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const rzp = require("./razorpay");
const PO = require("./payouts");
const L = require("./ledger");
const { TZ } = require("./tenantOps");
const { withLocks } = require("./locks");

const switchedOn = () => !/^(off|0|false|no)$/i.test(String(process.env.HN_ONLINE_RENT || "").trim());
const enabled = () => switchedOn() && PO.ready();
const MIN = 100;                         // the smallest amount a tenant can choose (₹), unless less is due
const REUSE_MS = 15 * 60 * 1000;         // pressing Pay again within 15 minutes reuses the same order

const inr = n => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const isId = v => typeof v === "string" ? mongoose.isValidObjectId(v) && /^[0-9a-f]{24}$/i.test(v) : v instanceof mongoose.Types.ObjectId;
const sleep = ms => new Promise(z => setTimeout(z, ms));
const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };
const TRF = /^trf_[A-Za-z0-9]{6,40}$/;
const PAY = /^pay_[A-Za-z0-9]{6,40}$/;

/** The ten digits of an Indian mobile number, or "". */
function mobile10(v) {
  let d = String(v || "").replace(/\D/g, "").replace(/^00/, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(2);
  if (d.length > 10 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}
// The ways a tenant's mobile number may have been typed by the owner.
const mobileVariants = phone => { const d = mobile10(phone); return d ? [d, "+91" + d, "91" + d, "0" + d, "+91 " + d, "+91-" + d] : []; };

/** The stays of this mobile number: tenants living in a HostelNode PG (not moved out, not removed). */
async function staysFor(phone) {
  const Member = require("../models/member");
  const v = mobileVariants(phone);
  if (!v.length) return [];
  return Member.find({ mobileNo: { $in: v }, leftDate: null, removedAt: null }).sort({ joiningDate: -1 }).limit(10);
}

/** What a tenant pays each month: their own rent, else their bed's rent, else the room's rent. */
function rentOf(member, room) {
  if (member && member.rent !== null && member.rent !== undefined && member.rent !== "") return Number(member.rent) || 0;
  const bed = room && (room.beds || []).find(b => b.label === (member && member.bedLabel));
  if (bed && bed.rent !== null && bed.rent !== undefined && bed.rent !== "") return Number(bed.rent) || 0;
  return Number(room && room.room_fees) || 0;
}

/** Fees on one payment of `amount` rent (whole rupees). */
function rate(type, value, amount) {
  const v = Math.max(0, Number(value) || 0);
  return type === "fixed" ? Math.round(v) : Math.round(amount * v / 100);
}
function quote(amount, settings, account) {
  const a = Math.round(Number(amount) || 0);
  const s = settings || {};
  const own = account && account.commission && account.commission.own ? account.commission : { type: s.commissionType, value: s.commissionValue };
  const fee = rate(s.feeType, s.feeValue === undefined ? 2 : s.feeValue, a);
  const commission = rate(own.type, own.value, a);
  const feePaidBy = s.feePaidBy === "tenant" ? "tenant" : "owner";
  const total = a + (feePaidBy === "tenant" ? fee : 0);
  return { amount: a, fee, commission, feePaidBy, total, toOwner: total - fee - commission };
}

/**
 * Can this tenant pay rent online now? { can, why, hostel, account }
 * why: off | left | property | cash_only | no_account
 */
async function availability(member, { hostel = null, account = null } = {}) {
  if (!enabled()) return { can: false, why: "off" };
  if (!member || member.leftDate || member.removedAt) return { can: false, why: "left" };
  const Hostel = require("../models/hostel");
  const PayoutAccount = require("../models/payoutAccount");
  hostel = hostel || await Hostel.findById(member.hostel, { hostelName: 1, onlineRent: 1, owner: 1, city: 1 }).lean();
  if (!hostel || String(hostel.owner) !== String(member.user)) return { can: false, why: "property", hostel };
  if (hostel.onlineRent === false) return { can: false, why: "cash_only", hostel };
  account = account || await PayoutAccount.findOne({ owner: member.user }).lean();
  if (!PO.canReceive(account) || !account.accountId) return { can: false, why: "no_account", hostel, account };
  return { can: true, why: "", hostel, account };
}

/**
 * Start (or reuse) a Razorpay order for `amount` rent. member: with payments populated.
 * Returns { order (RentOrder, lean), quote, due }. Throws with err.code: not_available | nothing_due | amount.
 */
async function startOrder({ member, studentId, amount }) {
  const RentOrder = require("../models/rentOrder");
  const PayoutSettings = require("../models/payoutSettings");
  const av = await availability(member);
  if (!av.can) throw fail("not_available", "Online payment is not available for this PG right now. Please pay the owner directly.");
  const due = L.ledgerOf(member).due;
  if (due <= 0) throw fail("nothing_due", "Nothing is due right now.");
  const a = Number(amount);
  const min = Math.min(MIN, due);
  if (!Number.isFinite(a) || Math.round(a) !== a || a < min || a > due) throw fail("amount", `Choose an amount from ${inr(min)} to ${inr(due)}.`);
  const q = quote(a, await PayoutSettings.read(), av.account);
  if (q.toOwner < 1) throw fail("amount", "That amount is too small to pay online. Please choose a larger amount.");
  const amountPaise = q.total * 100, toOwnerPaise = q.toOwner * 100;
  const onHold = !!(av.account.hold && av.account.hold.on);

  // Pressing Pay twice, or coming back after closing the window, reuses the same unpaid order
  // (only when nothing about it has changed).
  const recent = await RentOrder.findOne({
    member: member._id, student: studentId, status: { $in: ["created", "failed"] }, amount: a, amountPaise, toOwnerPaise,
    accountId: av.account.accountId, onHold, createdAt: { $gt: new Date(Date.now() - REUSE_MS) },
  }).sort({ createdAt: -1 }).lean();
  if (recent) return { order: recent, quote: q, due, hostel: av.hostel };

  const receipt = "HNR-" + moment().tz(TZ).format("YYYYMMDD") + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const property = String(av.hostel.hostelName || "").slice(0, 60);
  const order = await rzp.call("POST", "/v1/orders", {
    amount: amountPaise, currency: "INR", receipt,
    notes: { hn_kind: "rent", member: String(member._id), owner: String(member.user), property },
    transfers: [{
      account: av.account.accountId, amount: toOwnerPaise, currency: "INR",
      notes: { tenant: String(member.name || "").slice(0, 60), property, hn_member: String(member._id) },
      linked_account_notes: ["tenant", "property"],
      on_hold: onHold,
    }],
  });
  if (!order || typeof order.id !== "string" || Number(order.amount) !== amountPaise) throw new Error("Razorpay order did not match the request");
  const rec = await RentOrder.create({
    owner: member.user, hostel: member.hostel, member: member._id, student: studentId,
    amount: a, fee: q.fee, commission: q.commission, feePaidBy: q.feePaidBy, total: q.total, amountPaise, toOwnerPaise,
    accountId: av.account.accountId, onHold, dueAt: due, receipt, razorpayOrderId: order.id, status: "created",
  });
  return { order: rec.toObject(), quote: q, due, hostel: av.hostel };
}

// When the tenant paid (Razorpay's time, in seconds), so a late webhook still puts it on the right day.
function paidDate(at) {
  const d = Number(at) > 0 ? new Date(Number(at) * 1000) : null;
  return d && d <= new Date(Date.now() + 5 * 60e3) && d > new Date(Date.now() - 30 * 86400e3) ? d : new Date();
}

const METHODS = { upi: "UPI", card: "Card", netbanking: "Netbanking", wallet: "Wallet", emi: "EMI", paylater: "Pay later", bank_transfer: "Bank transfer" };
const modeOf = method => (METHODS[method] ? METHODS[method] + " (online)" : "Online");

/**
 * Record a confirmed payment once. match: { orderId } (order_…) or { id } (RentOrder id).
 * Only call after Razorpay's signature was checked, or with a payment fetched from Razorpay.
 * Returns { ok, fresh (this call recorded it), order, payment } or { ok: false, why }.
 */
async function fulfil(match, { paymentId = "", method = "", via = "", at = null } = {}) {
  const RentOrder = require("../models/rentOrder");
  const Payment = require("../models/payment");
  const Member = require("../models/member");
  const P = require("./payments");
  const found = match.id && isId(String(match.id)) ? await RentOrder.findById(match.id).lean()
    : typeof match.orderId === "string" && match.orderId ? await RentOrder.findOne({ razorpayOrderId: match.orderId }).lean() : null;
  if (!found) return { ok: false, why: "not_found" };
  for (let i = 0; i < 40; i++) {
    const r = await withLocks([`rentorder:${found._id}`], async () => {
      const rec = await RentOrder.findById(found._id).lean();
      if (rec.status === "paid" && rec.payment) {
        // A second payment on an order that was already paid (two tabs): it is not rent twice. Kept for
        // HostelNode admin to refund (shown on the owner's payouts page in admin).
        if (PAY.test(paymentId) && rec.razorpayPaymentId && paymentId !== rec.razorpayPaymentId && !(rec.extraPayments || []).includes(paymentId)) {
          await RentOrder.updateOne({ _id: rec._id }, { $addToSet: { extraPayments: paymentId } });
          console.error("ONLINE RENT: a second payment on an order already paid; refund it in Razorpay:", rec.razorpayOrderId, paymentId);
        }
        return { ok: true, fresh: false, duplicate: !!(PAY.test(paymentId) && paymentId !== rec.razorpayPaymentId), order: rec, payment: await Payment.findById(rec.payment).lean() };
      }
      const pid = PAY.test(paymentId) ? paymentId : rec.razorpayPaymentId;
      if (!PAY.test(pid || "")) return { ok: false, why: "no_payment" };
      // Saved before and the order was not marked (an interrupted request): use that entry (and make sure it is on the tenant).
      let entry = await Payment.findOne({ memberId: rec.member, "online.paymentId": pid }).lean();
      let fresh = false;
      if (entry) await Member.updateOne({ _id: rec.member }, { $addToSet: { payments: entry._id } });
      if (!entry) {
        const member = await Member.findById(rec.member);
        if (!member) return { ok: false, why: "no_tenant" };
        const out = await P.recordPayment({
          ownerId: rec.owner, member, amount: rec.amount, mode: modeOf(method), reference: pid, date: paidDate(at),
          by: { id: rec.student || undefined, name: member.name, role: "tenant" },
          extra: {
            tenantName: member.name,
            online: { orderId: rec.razorpayOrderId, paymentId: pid, method: method || "", rentOrder: rec._id, total: rec.total },
            payout: { status: rec.onHold ? "on_hold" : "pending", amount: rec.toOwnerPaise / 100, gatewayFee: rec.fee, commission: rec.commission, feePaidBy: rec.feePaidBy, accountId: rec.accountId },
          },
        });
        entry = out.payment;
        fresh = true;
      }
      await RentOrder.updateOne({ _id: rec._id }, { $set: { status: "paid", payment: entry._id, razorpayPaymentId: pid, method: method || rec.method || "", paidAt: rec.paidAt || new Date(), via: rec.via || via, failureReason: "" } });
      return { ok: true, fresh, order: Object.assign({}, rec, { status: "paid", payment: entry._id, razorpayPaymentId: pid }), payment: entry };
    });
    if (!r.busy) return r.value;
    await sleep(150);   // another request is recording it right now
  }
  return { ok: true, pending: true };
}

/** After a payment was recorded (fresh): receipt on WhatsApp, then the transfer's status. Never throws. */
function afterPaid(result) {
  if (!result || !result.ok || !result.fresh || !result.payment) return;
  const id = result.payment._id;
  setImmediate(() => { sendReceipt(id).catch(() => {}); });
  // Razorpay makes the transfer a moment after the payment is captured.
  setTimeout(() => { syncTransfer(id, { applyHold: true }).catch(e => console.error("Rent transfer check (non-fatal):", e.message)); }, 8000).unref();
}

/** The rent receipt PDF on WhatsApp to the tenant (only when its template is set). Never throws. */
async function sendReceipt(paymentId) {
  try {
    const Payment = require("../models/payment");
    const Member = require("../models/member");
    const P = require("./payments");
    const PDF = require("./ledgerPdf");
    if (!PDF.receiptOn()) return { sent: false, why: "off" };
    const p = await Payment.findById(paymentId).lean();
    if (!p) return { sent: false, why: "missing" };
    const m = await Member.findById(p.memberId).populate("payments");
    if (!m) return { sent: false, why: "missing" };
    const r = await P.receiptFor(p.user, m, p);
    return await PDF.sendReceiptWhatsApp({ phone: m.mobileNo, tenantName: m.name, property: r.property, amount: inr(r.amount), mode: r.mode, date: r.date, forText: P.forText(r.applied), receiptNo: r.receiptNo, pdf: PDF.buildReceiptPdf(r) });
  } catch (err) {
    console.error("Online rent receipt WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

/** Where a transfer is, in HostelNode's words. */
function payoutStatusOf(t) {
  if (!t) return "pending";
  if (t.status === "failed") return "failed";
  if (t.status === "reversed" || (Number(t.amount_reversed) > 0 && Number(t.amount_reversed) >= Number(t.amount))) return "reversed";
  if (t.settlement_status === "settled") return "settled";
  if (t.on_hold || t.settlement_status === "on_hold") return "on_hold";
  return "pending";
}

/**
 * Ask Razorpay where the owner's share of one online payment is, and save it on the entry.
 * applyHold: also put it on hold (or release it) when the owner's hold changed after the order was made.
 */
async function syncTransfer(paymentId, { applyHold = false } = {}) {
  const Payment = require("../models/payment");
  const p = await Payment.findById(paymentId).lean();
  if (!p || !p.online || !PAY.test(p.online.paymentId || "")) return null;
  const po = p.payout || {};
  let t = null;
  if (TRF.test(po.transferId || "")) t = await rzp.call("GET", `/v1/transfers/${po.transferId}?expand[]=recipient_settlement`);
  else {
    const list = await rzp.call("GET", `/v1/payments/${p.online.paymentId}/transfers`);
    const items = Array.isArray(list && list.items) ? list.items : [];
    const forOwner = items.filter(x => x && x.recipient === po.accountId).sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
    t = forOwner.find(x => x.status !== "failed") || forOwner[0] || null;   // a transfer sent again after one failed
    if (t && TRF.test(t.id || "") && t.settlement_status === "settled") {
      try { t = await rzp.call("GET", `/v1/transfers/${t.id}?expand[]=recipient_settlement`); } catch { /* the date is filled next time */ }
    }
  }
  const set = { "payout.checkedAt": new Date() };
  if (t && TRF.test(t.id || "")) {
    const status = payoutStatusOf(t);
    set["payout.transferId"] = t.id;
    set["payout.status"] = status;
    if (status === "settled") {
      const rs = t.recipient_settlement && typeof t.recipient_settlement === "object" ? t.recipient_settlement : null;
      set["payout.settledAt"] = rs && Number(rs.created_at) ? new Date(Number(rs.created_at) * 1000) : (po.settledAt || new Date());
    }
    set["payout.error"] = t.error && (t.error.description || t.error.reason) ? String(t.error.description || t.error.reason).slice(0, 200) : "";
  }
  await Payment.updateOne({ _id: p._id }, { $set: set });
  // Held or released by HostelNode admin after the tenant started paying: follow the owner's setting now.
  if (applyHold && t && TRF.test(t.id || "") && ["pending", "on_hold"].includes(set["payout.status"])) {
    const PayoutAccount = require("../models/payoutAccount");
    const acc = await PayoutAccount.findOne({ owner: p.user }, { hold: 1 }).lean();
    const want = !!(acc && acc.hold && acc.hold.on);
    if (want !== (set["payout.status"] === "on_hold")) {
      await rzp.call("PATCH", `/v1/transfers/${t.id}`, { on_hold: want });
      return syncTransfer(paymentId);
    }
  }
  return Object.assign({}, p, { payout: Object.assign({}, po, ...Object.keys(set).map(k => ({ [k.slice(7)]: set[k] }))) });
}

/** Check online payments whose money is not in the owner's bank yet (cron, a few at a time). */
async function syncPending({ limit = 40 } = {}) {
  if (!PO.ready()) return 0;
  const Payment = require("../models/payment");
  const list = await Payment.find({
    "recordedBy.role": "tenant", "payout.status": { $in: ["pending", "on_hold"] }, cancelledAt: { $exists: false },   // (refunded ones are left to admin)
    paymentDate: { $gt: new Date(Date.now() - 90 * 86400e3) },
  }, { _id: 1 }).sort({ "payout.checkedAt": 1 }).limit(limit).lean();
  let n = 0;
  for (const p of list) {
    try { await syncTransfer(p._id, { applyHold: true }); n++; } catch (e) { console.error("Rent transfer check (non-fatal):", e.message); }
  }
  return n;
}

/** Find the entry for a transfer event (by transfer id, or by its order) and check it. Never throws. */
async function syncForTransfer(t) {
  try {
    const Payment = require("../models/payment");
    if (!t || typeof t !== "object") return null;
    let p = TRF.test(t.id || "") ? await Payment.findOne({ "payout.transferId": t.id }, { _id: 1 }).lean() : null;
    if (!p && /^order_/.test(t.source || "")) p = await Payment.findOne({ "online.orderId": t.source }, { _id: 1 }).lean();
    if (!p && /^pay_/.test(t.source || "")) p = await Payment.findOne({ "online.paymentId": t.source }, { _id: 1 }).lean();
    return p ? await syncTransfer(p._id) : null;
  } catch (err) {
    console.error("Rent transfer webhook (non-fatal):", err.message);
    return null;
  }
}

/**
 * HostelNode admin held or released an owner's payouts: apply it to their online rent not yet in the bank.
 * Returns { done, failed }.
 */
async function applyHold(ownerId, on) {
  const Payment = require("../models/payment");
  const list = await Payment.find({ user: ownerId, "recordedBy.role": "tenant", "payout.status": { $in: on ? ["pending"] : ["on_hold"] }, cancelledAt: { $exists: false } }, { _id: 1, payout: 1 }).lean();
  let done = 0, failed = 0;
  for (const p of list) {
    try {
      let id = p.payout && p.payout.transferId;
      if (!TRF.test(id || "")) { const s = await syncTransfer(p._id); id = s && s.payout && s.payout.transferId; }
      if (!TRF.test(id || "")) { failed++; continue; }
      await rzp.call("PATCH", `/v1/transfers/${id}`, { on_hold: !!on });
      await syncTransfer(p._id);
      done++;
    } catch (err) {
      failed++;
      console.error("Payout hold change (non-fatal):", PO.redact(err.message));
    }
  }
  return { done, failed };
}

/** Admin: send the owner's share again after Razorpay said the transfer failed. Returns the entry. */
async function retryTransfer(paymentId) {
  const Payment = require("../models/payment");
  const PayoutAccount = require("../models/payoutAccount");
  return locked(`retrytrf:${paymentId}`, async () => {
    const before = await syncTransfer(paymentId);   // make sure it really failed (and nothing was sent since)
    if (!before || !before.payout || before.payout.status !== "failed") throw fail("not_failed", "This payout has not failed.");
    const all = await rzp.call("GET", `/v1/payments/${before.online.paymentId}/transfers`);
    if ((Array.isArray(all && all.items) ? all.items : []).some(x => x && x.status !== "failed")) throw fail("not_failed", "Razorpay already has a transfer for this payment that has not failed. Check again.");
    const acc = await PayoutAccount.findOne({ owner: before.user }).lean();
    if (!PO.canReceive(acc) || acc.accountId !== before.payout.accountId) throw fail("account", "The owner's payout account is not active with the same Razorpay account.");
    const out = await rzp.call("POST", `/v1/payments/${before.online.paymentId}/transfers`, { transfers: [{ account: acc.accountId, amount: Math.round(Number(before.payout.amount) * 100), currency: "INR", on_hold: !!(acc.hold && acc.hold.on) }] });
    const t = Array.isArray(out && out.items) ? out.items[0] : out;
    if (!t || !TRF.test(t.id || "")) throw new Error("Razorpay did not return a transfer");
    await Payment.updateOne({ _id: before._id }, { $set: { "payout.transferId": t.id, "payout.status": payoutStatusOf(t), "payout.error": "", "payout.checkedAt": new Date() } });
    return Payment.findById(before._id).lean();
  });
}
async function locked(key, fn) {
  const r = await withLocks([key], fn);
  if (r.busy) throw fail("busy", "Someone is doing this right now. Please try again in a moment.");
  return r.value;
}

/**
 * Razorpay refunded an online rent payment in full (HostelNode support did it in the Razorpay Dashboard):
 * the ledger entry is cancelled, so the rent shows as due again. Returns true when it changed.
 */
async function refunded(pay) {
  const Payment = require("../models/payment");
  const RentOrder = require("../models/rentOrder");
  if (!pay || !PAY.test(pay.id || "") || !(Number(pay.amount) > 0)) return false;
  if (!(Number(pay.amount_refunded) >= Number(pay.amount))) {   // part refunds are not changed in the ledger (see the Phase 7 notes)
    if (Number(pay.amount_refunded) > 0) console.error("ONLINE RENT: part refund, ledger not changed:", pay.id, pay.amount_refunded);
    return false;
  }
  // A second payment that was refunded: nothing more to do.
  await RentOrder.updateOne({ extraPayments: pay.id }, { $pull: { extraPayments: pay.id } });
  const r = await Payment.updateOne({ "online.paymentId": pay.id, cancelledAt: { $exists: false } },
    { $set: { cancelledAt: new Date(), cancelReason: "Refunded to the tenant through Razorpay", cancelledBy: { name: "HostelNode" } } });
  // Where the owner's share is now (reversed when the refund was made with "reverse transfers").
  const p = await Payment.findOne({ "online.paymentId": pay.id }, { _id: 1 }).lean();
  if (p) await syncTransfer(p._id).catch(e => console.error("Refund transfer check (non-fatal):", e.message));
  return r.modifiedCount > 0;
}

/* ── Notice to leave, asked by the tenant ───────────────────── */
const noticeOf = m => (m && m.noticeRequest && m.noticeRequest.status ? m.noticeRequest : null);

/** The tenant asks to leave on `date` (a day in India time). Returns true when saved. */
async function requestNotice(member, { date, reason }) {
  const Member = require("../models/member");
  const r = await Member.updateOne({ _id: member._id, leftDate: null, removedAt: null },
    { $set: { noticeRequest: { date, reason: String(reason || "").slice(0, 120), at: new Date(), status: "pending" } } });
  return r.modifiedCount > 0;
}
async function withdrawNotice(member) {
  const Member = require("../models/member");
  const r = await Member.updateOne({ _id: member._id, "noticeRequest.status": "pending" }, { $set: { "noticeRequest.status": "withdrawn", "noticeRequest.decidedAt": new Date() } });
  return r.modifiedCount > 0;
}

module.exports = {
  enabled, MIN, inr, mobile10, refunded, paidDate, mobileVariants, staysFor, rentOf, quote, availability, startOrder, fulfil, afterPaid, modeOf,
  sendReceipt, syncTransfer, syncPending, syncForTransfer, applyHold, retryTransfer, payoutStatusOf, noticeOf, requestNotice, withdrawNotice,
};
