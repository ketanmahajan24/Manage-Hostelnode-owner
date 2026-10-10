/* ============================================================
   routes/checkoutRoutes.js  —  Subscriptions Phase 3
   Mounted at /user in app.js:
     GET  /user/account/checkout/:planId          the pay page
     POST /user/account/checkout/:planId/order    start a Razorpay order
     POST /user/account/checkout/verify           browser return after paying
     GET  /user/account/checkout/done/:id         result page (success / pending / not paid)
     GET  /user/account/checkout/receipt/:id      printable receipt

   The webhook (Razorpay → server) is the second export, mounted at
   /payments/razorpay in app.js:
     POST /payments/razorpay/webhook

   Rules that keep money safe:
     • The amount always comes from the plan record on the server.
     • A plan is activated only after Razorpay's signature checks out.
     • One payment activates one plan, however many times we hear about it.
     • An owner can only see their own payments.
============================================================ */

const express  = require("express");
const mongoose = require("mongoose");
const crypto   = require("crypto");
const router   = express.Router();
const webhook  = express.Router();

const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner               = require("../models/owner");
const SubscriptionPayment = require("../models/subscriptionPayment");
const rzp = require("../utils/razorpay");
const { LIMITS, FEATURES } = require("../config/planFeatures");
const { snapshotOf } = require("../utils/subscription");
const { findBuyablePlan, validityFor, fulfilPayment, durationText } = require("../utils/subscriptionPayments");

const SUPPORT_EMAIL = "hostelnodehelp@gmail.com";
const REUSE_ORDER_MS = 15 * 60 * 1000;

const validId = id => typeof id === "string" && mongoose.isValidObjectId(id);
const day = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const dayTime = d => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = n => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(n) || 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Optional links shown on the pay page (set in .env; left out when empty).
function policyUrl() {
  const u = String(process.env.HN_REFUND_POLICY_URL || "").trim();
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "";
}
function supportPhone() {
  const p = String(process.env.HN_SUPPORT_WHATSAPP || "").replace(/\D/g, "");
  return /^\d{10}$/.test(p) ? p : "";
}

// What a plan includes, as short lines for the summary.
function includes(snapshot) {
  const words = {
    maxProperties: n => (n === null ? "Unlimited properties" : n === 1 ? "1 property" : `Up to ${n} properties`),
    maxTenants:    n => (n === null ? "Unlimited tenants" : `Up to ${plural(n, "active tenant")}`),
    maxListings:   n => (n === null ? "Unlimited listings on hostelnode.com" : `${plural(n, "listing")} on hostelnode.com`),
  };
  const out = [];
  LIMITS.forEach(l => { const v = snapshot.limits ? snapshot.limits[l.key] : null; if (words[l.key]) out.push(words[l.key](v === null || v === undefined ? null : Number(v))); });
  FEATURES.forEach(f => { if (snapshot.features && snapshot.features[f.key]) out.push(f.label); });
  (snapshot.displayPoints || []).forEach(p => out.push(p));
  return out;
}

// What the receipt shows, used by the receipt page and the PDF alike.
function receiptData(rec, sub, owner) {
  const snap = rec.snapshot || {};
  return {
    receipt: rec.receipt, paidAt: dayTime(rec.paidAt || rec.updatedAt), amount: rec.amount,
    planName: snap.name || "Plan", duration: durationText(snap.duration),
    from: sub && sub.startsAt ? day(sub.startsAt) : "—", until: sub && sub.expiresAt ? day(sub.expiresAt) : "—",
    paymentId: rec.razorpayPaymentId || "—", orderId: rec.razorpayOrderId, method: rec.method || "",
    owner: { name: owner.name || "", business: owner.businessName || "", email: owner.email || "", phone: owner.phone || "", place: [owner.city, owner.state].filter(Boolean).join(", ") },
    supportEmail: SUPPORT_EMAIL,
  };
}

async function mail(to, subject, html, attachments) {
  try {
    if (!to) return;
    if (process.env.MAIL_USER && process.env.MAIL_PASS) {
      const nodemailer = require("nodemailer");
      const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
      await t.sendMail({ from: `"HostelNode" <${process.env.MAIL_USER}>`, to, subject, html, ...(attachments && attachments.length ? { attachments } : {}) });
    } else {
      await require("../utils/sendMail").sendMail(to, subject, html);
    }
  } catch (err) {
    console.error("Receipt mail (non-fatal):", err.message);
  }
}

// Receipt email and WhatsApp message, sent once: only by the call that actually activated the plan.
async function sendReceipt(result) {
  try {
    if (!result || !result.ok || !result.fresh || !result.record) return;
    const rec = result.record, sub = result.subscription || {};
    const owner = await Owner.findById(rec.owner).select("name email phone businessName city state").lean();
    if (!owner) return;
    const snap = rec.snapshot || {};
    // The receipt as a PDF (if it cannot be built, the email still goes, without the file).
    let pdf = null;
    try { pdf = require("../utils/receiptPdf").buildReceiptPdf(receiptData(rec, sub, owner)); }
    catch (e) { console.error("Receipt PDF (non-fatal):", e.message); }
    // WhatsApp: the PDF, from HostelNode's WhatsApp number. Not awaited; never stops the email.
    try {
      if (pdf) require("../utils/planReceiptWhatsapp").sendPlanReceiptWhatsApp({
        phone: owner.phone, ownerName: owner.name, planName: snap.name,
        amountText: inr(rec.amount), validUntil: sub.expiresAt ? day(sub.expiresAt) : "-", receiptNo: rec.receipt, pdf,
      }).catch(() => {});
    } catch (e) { console.error("Receipt WhatsApp (non-fatal):", e.message); }
    if (!owner.email) return;
    const canAttach = !!(process.env.MAIL_USER && process.env.MAIL_PASS);   // the fallback mailer sends no files
    const files = pdf && canAttach ? [{ filename: `HostelNode-Receipt-${String(rec.receipt || "").replace(/[^A-Za-z0-9-]/g, "")}.pdf`, content: pdf, contentType: "application/pdf" }] : [];
    await mail(owner.email, `Payment received — ${snap.name} plan is active`,
      `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;padding:24px;color:#12151a">
        <h2 style="color:#0a7d4c;margin:0 0 6px">Payment received</h2>
        <p style="margin:0 0 18px;color:#475467">Hi ${esc(owner.name)}, your <b>${esc(snap.name)}</b> plan is active.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#667085">Plan</td><td style="padding:8px 0;text-align:right"><b>${esc(snap.name)}</b> (${esc(durationText(snap.duration))})</td></tr>
          <tr><td style="padding:8px 0;color:#667085">Amount paid</td><td style="padding:8px 0;text-align:right"><b>${esc(inr(rec.amount))}</b></td></tr>
          <tr><td style="padding:8px 0;color:#667085">Valid until</td><td style="padding:8px 0;text-align:right"><b>${sub.expiresAt ? esc(day(sub.expiresAt)) : "—"}</b></td></tr>
          <tr><td style="padding:8px 0;color:#667085">Receipt no.</td><td style="padding:8px 0;text-align:right">${esc(rec.receipt)}</td></tr>
          <tr><td style="padding:8px 0;color:#667085">Razorpay payment ID</td><td style="padding:8px 0;text-align:right">${esc(rec.razorpayPaymentId || "—")}</td></tr>
        </table>
        <p style="margin:18px 0 0;color:#667085;font-size:13px">${files.length ? "Your receipt is attached as a PDF. " : ""}You can see this payment any time under Billing in your HostelNode dashboard. Questions? Reply to this email or write to ${SUPPORT_EMAIL}.</p>
      </div>`, files);
  } catch (err) {
    console.error("Receipt mail (non-fatal):", err.message);
  }
}

// Everything below needs online payment to be switched on.
function needRazorpay(req, res, next) {
  if (rzp.configured()) return next();
  if (req.method === "GET") return res.redirect("/user/account/plans");
  res.status(503).json({ ok: false, error: "Online payment is not available right now." });
}

/* ── PAY PAGE ────────────────────────────────────────────── */
router.get("/account/checkout/:planId", jwtAuthMiddleware, needRazorpay, attachHostel, async (req, res, next) => {
  try {
    if (!validId(req.params.planId)) return res.redirect("/user/account/plans");
    const user = await Owner.findById(req.user.id);
    if (!user) return res.redirect("/login");
    const plan = await findBuyablePlan(req.params.planId);
    if (!plan) return res.redirect("/user/account/plans?gone=1");

    const snap = snapshotOf(plan);
    const v = await validityFor(user._id, plan._id, plan.duration);
    res.render("account/checkout.ejs", {
      user,
      pay: {
        planId: String(plan._id), name: plan.name, description: plan.description || "",
        price: plan.price, strikePrice: plan.strikePrice && plan.strikePrice > plan.price ? plan.strikePrice : null,
        duration: durationText(plan.duration), includes: includes(snap),
        renewing: v.renewing, currentEndsAt: v.currentEndsAt ? day(v.currentEndsAt) : "",
        startsOn: day(v.startsAt), validUntil: day(v.expiresAt),
        keyId: rzp.keyId(), testMode: rzp.isTestMode(),
        policyUrl: policyUrl(), supportEmail: SUPPORT_EMAIL, supportPhone: supportPhone(),
        prefill: { name: user.name || "", email: user.email || "", contact: user.phone || "" },
      },
    });
  } catch (err) {
    console.error("Checkout page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/* ── START AN ORDER ──────────────────────────────────────── */
router.post("/account/checkout/:planId/order", jwtAuthMiddleware, needRazorpay, async (req, res) => {
  try {
    if (!validId(req.params.planId) || !validId(String(req.user.id))) return res.status(400).json({ ok: false, error: "That plan is not available." });
    const owner = await Owner.findById(req.user.id).select("_id email status").lean();
    if (!owner) return res.status(401).json({ ok: false, error: "Please log in again." });
    if (owner.status === "Banned") return res.status(403).json({ ok: false, error: "This account cannot buy a plan. Please contact support." });
    const plan = await findBuyablePlan(req.params.planId);
    if (!plan) return res.status(400).json({ ok: false, error: "That plan is no longer available. Please go back and choose again." });

    const amountPaise = Math.round(Number(plan.price) * 100);
    const now = new Date();

    // Pressing Pay twice, or coming back after closing the window, reuses the
    // same unpaid order — as long as the plan has not been edited since.
    const snap = snapshotOf(plan);
    const recent = await SubscriptionPayment.findOne({
      owner: owner._id, plan: plan._id, status: { $in: ["created", "failed"] }, subscription: null,
      amountPaise, createdAt: { $gt: new Date(now.getTime() - REUSE_ORDER_MS) },
    }).sort({ createdAt: -1 }).lean();
    if (recent && JSON.stringify(recent.snapshot) === JSON.stringify(snap)) {
      return res.json({ ok: true, orderId: recent.razorpayOrderId, amount: amountPaise, recordId: String(recent._id) });
    }

    const receipt = "HN-" + now.toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const order = await rzp.createOrder({
      amountPaise, receipt,
      notes: { owner: String(owner._id), plan: String(plan._id), planName: String(plan.name).slice(0, 60) },
    });
    if (!order || typeof order.id !== "string" || Number(order.amount) !== amountPaise) throw new Error("Razorpay order did not match the request");

    const rec = await SubscriptionPayment.create({
      owner: owner._id, plan: plan._id, snapshot: snap,
      amount: plan.price, amountPaise, receipt, razorpayOrderId: order.id, status: "created",
    });
    res.json({ ok: true, orderId: order.id, amount: amountPaise, recordId: String(rec._id) });
  } catch (err) {
    console.error("Checkout order error:", err.message);
    res.status(502).json({ ok: false, error: "We could not start the payment. Nothing was charged. Please try again." });
  }
});

/* ── BROWSER RETURN AFTER PAYING ─────────────────────────── */
router.post("/account/checkout/verify", jwtAuthMiddleware, needRazorpay, async (req, res) => {
  try {
    const b = req.body || {};
    const orderId   = typeof b.razorpay_order_id === "string" ? b.razorpay_order_id : "";
    const paymentId = typeof b.razorpay_payment_id === "string" ? b.razorpay_payment_id : "";
    const signature = typeof b.razorpay_signature === "string" ? b.razorpay_signature : "";

    // The order must be this owner's own.
    const rec = orderId ? await SubscriptionPayment.findOne({ razorpayOrderId: orderId, owner: req.user.id }).select("_id amountPaise").lean() : null;
    if (!rec) return res.status(400).json({ ok: false, error: "We could not match this payment. If money was deducted, it will be activated automatically or refunded." });

    if (!rzp.validCheckoutSignature({ orderId, paymentId, signature })) {
      console.error("Checkout verify: bad signature for order", orderId);
      return res.status(400).json({ ok: false, error: "We could not confirm this payment yet.", redirect: `/user/account/checkout/done/${rec._id}` });
    }

    // The signature is genuine. Now make sure the money is actually collected
    // ("captured") and is for this order and amount. If Razorpay only holds it
    // ("authorized"), collect it. If Razorpay cannot be reached right now, the
    // genuine signature is accepted, which is Razorpay's standard check.
    const doneUrl = `/user/account/checkout/done/${rec._id}`;
    let method = "";
    try {
      let pay = await rzp.fetchPayment(paymentId);
      if (pay.order_id !== orderId || Number(pay.amount) !== rec.amountPaise || pay.currency !== "INR") {
        console.error("Checkout verify: payment does not match order", orderId, paymentId);
        return res.status(400).json({ ok: false, error: "We could not confirm this payment yet.", redirect: doneUrl });
      }
      if (pay.status === "authorized") {
        try { pay = await rzp.capturePayment(paymentId, rec.amountPaise); }
        catch (e) { pay = await rzp.fetchPayment(paymentId); }   // e.g. Razorpay captured it itself meanwhile
      }
      if (pay.status !== "captured") {
        // Not collected yet: Razorpay's webhook will activate the plan when it is.
        return res.json({ ok: true, waiting: true, redirect: doneUrl + "?w=1" });
      }
      method = pay.method || "";
    } catch (err) {
      console.error("Checkout verify: could not ask Razorpay, using signature only:", err.message);
    }

    const result = await fulfilPayment({ id: rec._id }, { razorpayPaymentId: paymentId, via: "checkout", method });
    if (req.session) delete req.session.hnBanner;   // Phase 4: the "plan ends soon" notice is out of date now
    sendReceipt(result);   // not awaited: the owner should not wait for email
    res.json({ ok: !!result.ok, redirect: doneUrl });
  } catch (err) {
    console.error("Checkout verify error:", err.message);
    res.status(500).json({ ok: false, error: "Your payment is being confirmed. Please check Billing in a minute." });
  }
});

// A payment record that belongs to the logged-in owner, or null.
async function ownPayment(req) {
  if (!validId(req.params.id) || !validId(String(req.user.id))) return null;
  return SubscriptionPayment.findOne({ _id: req.params.id, owner: req.user.id }).populate("subscription").lean();
}

/* ── RESULT PAGE ─────────────────────────────────────────── */
router.get("/account/checkout/done/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    if (!user) return res.redirect("/login");
    let rec = await ownPayment(req);
    if (!rec) return res.redirect("/user/account/billing");
    if (req.session) delete req.session.hnBanner;   // Phase 4: refresh the "plan ends soon" notice after a payment

    // Paid but the plan is not active yet (an earlier step was interrupted):
    // finish it now. "paid" is only ever set after Razorpay's signature was checked.
    if (rec.status === "paid" && !rec.subscription) {
      try { sendReceipt(await fulfilPayment({ id: rec._id }, { via: "checkout" })); rec = await ownPayment(req); }
      catch (e) { console.error("Checkout result: finishing activation failed:", e.message); }
    }

    const snap = rec.snapshot || {};
    const sub = rec.subscription;
    // ?w=1: the owner has just paid and Razorpay is still collecting the money.
    const waiting = req.query.w === "1" && rec.status === "created";
    const state = rec.status === "refunded" ? "refunded" : sub ? "success" : (rec.status === "paid" || waiting) ? "pending" : "notpaid";
    res.render("account/checkoutDone.ejs", {
      user,
      done: {
        state, id: String(rec._id), planId: String(rec.plan), planName: snap.name || "Plan",
        duration: durationText(snap.duration), amount: rec.amount,
        validUntil: sub && sub.expiresAt ? day(sub.expiresAt) : "",
        paidAt: rec.paidAt ? dayTime(rec.paidAt) : "", receipt: rec.receipt,
        paymentId: rec.razorpayPaymentId || "", supportEmail: SUPPORT_EMAIL,
        failureReason: rec.status === "failed" ? rec.failureReason : "",
      },
    });
  } catch (err) {
    console.error("Checkout result error:", err.message);
    res.status(500).send("Something went wrong. Please check Billing.");
  }
});

/* ── PRINTABLE RECEIPT ───────────────────────────────────── */
router.get("/account/checkout/receipt/:id", jwtAuthMiddleware, async (req, res) => {
  try {
    const rec = await ownPayment(req);
    if (!rec || rec.status !== "paid" || !rec.subscription) return res.redirect("/user/account/billing");
    const owner = await Owner.findById(req.user.id).select("name email phone businessName city state").lean();
    if (!owner) return res.redirect("/login");
    const snap = rec.snapshot || {};
    res.render("account/receipt.ejs", {
      r: receiptData(rec, rec.subscription, owner),
    });
  } catch (err) {
    console.error("Receipt error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/* ── WEBHOOK: Razorpay tells the server directly ─────────────
   Works even if the owner closed the browser right after paying.
   Always answers 200 once the signature is valid, so Razorpay
   does not keep retrying things we have already handled. */
webhook.post("/webhook", async (req, res) => {
  try {
    // (Phase 6: owner payout events only need the keys and the webhook secret, even with plan billing off.)
    if (!rzp.webhookSecret() || !rzp.keyId()) return res.status(503).send("not configured");
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    const signature = req.get("x-razorpay-signature") || "";
    if (!raw || !rzp.validWebhookSignature(raw, signature)) return res.status(400).send("bad signature");

    let evt;
    try { evt = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).send("bad body"); }
    const type = typeof evt.event === "string" ? evt.event : "";
    // Property Operations Phase 6: an owner's linked account (payouts) changed. The payload is not
    // trusted: the latest status is fetched from Razorpay for that account.
    if (/^(account|product)\./.test(type)) {
      const p = evt.payload || {};
      const ids = [p.account && p.account.entity && p.account.entity.id, p.merchant_product && p.merchant_product.entity && p.merchant_product.entity.account_id,
        p.product && p.product.entity && p.product.entity.account_id, evt.account_id].filter(x => typeof x === "string" && /^acc_/.test(x));
      // Answered at once; the status is fetched from Razorpay just after (Razorpay does not wait for it).
      const unique = [...new Set(ids)];
      if (unique.length) setImmediate(() => { (async () => { for (const id of unique) await require("../utils/payouts").refreshAccount(id); })().catch(e => console.error("Payout webhook refresh (non-fatal):", e.message)); });
      return res.status(200).send(unique.length ? "ok" : "ignored");
    }
    // Property Operations Phase 7: rent paid online by a tenant (My PG on hostelnode.com).
    // Transfers: where the owner's share is. The payload is not trusted: it is fetched from Razorpay.
    if (/^transfer\./.test(type) || type === "settlement.processed") {
      const OR = require("../utils/onlineRent");
      const t = evt.payload && evt.payload.transfer && evt.payload.transfer.entity;
      setImmediate(() => { (t ? OR.syncForTransfer(t) : OR.syncPending({ limit: 40 })).catch(e => console.error("Rent transfer webhook (non-fatal):", e.message)); });
      return res.status(200).send("ok");
    }
    const rentPay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
    const rentOrder = rentPay && typeof rentPay.order_id === "string" && /^order_/.test(rentPay.order_id)
      ? await require("../models/rentOrder").findOne({ razorpayOrderId: rentPay.order_id }).select("_id amountPaise status").lean() : null;
    if (rentOrder) return rentWebhook(type, rentPay, rentOrder, res);
    // Property Operations Phase 8: a payment on a booking from a listing.
    const bookingOrder = rentPay && typeof rentPay.order_id === "string" && /^order_/.test(rentPay.order_id)
      ? await require("../models/booking").findOne({ razorpayOrderId: rentPay.order_id }).select("_id amountPaise status razorpayPaymentId").lean() : null;
    if (bookingOrder) return bookingWebhook(type, rentPay, bookingOrder, res);

    if (!rzp.configured()) return res.status(503).send("not configured");
    const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
    const orderId = pay && typeof pay.order_id === "string" ? pay.order_id : "";
    if (!pay || !orderId) return res.status(200).send("ignored");

    const rec = await SubscriptionPayment.findOne({ razorpayOrderId: orderId }).select("_id amountPaise status subscription").lean();
    if (!rec) return res.status(200).send("not ours");   // e.g. a payment made elsewhere on the same Razorpay account

    if (type === "payment.captured" || type === "order.paid") {
      if (pay.status !== "captured" || Number(pay.amount) !== rec.amountPaise || pay.currency !== "INR") {
        console.error("Razorpay webhook: payment does not match order", orderId, pay.status, pay.amount);
        return res.status(200).send("mismatch");
      }
      const result = await fulfilPayment({ id: rec._id }, { razorpayPaymentId: pay.id, via: "webhook", method: pay.method });
      sendReceipt(result);
      // Another request is activating it right now. Ask Razorpay to call again,
      // so the plan is still activated if that other request never finishes.
      if (result.ok && result.pending) return res.status(503).send("busy, retry");
      return res.status(200).send("ok");
    }
    if (type === "payment.failed") {
      // Only a note for the owner; a later attempt on the same order can still succeed.
      await SubscriptionPayment.updateOne(
        { _id: rec._id, status: { $in: ["created", "failed"] }, subscription: null },
        { $set: { status: "failed", failureReason: String((pay.error_description || pay.error_reason || "Payment failed")).slice(0, 200) } }
      );
      return res.status(200).send("ok");
    }
    if (type === "refund.processed" || type === "payment.refunded") {
      // You refunded it in Razorpay. The plan is NOT cancelled automatically:
      // cancel it from the owner's page in admin if that is what you want.
      if (Number(pay.amount_refunded) >= rec.amountPaise) {
        await SubscriptionPayment.updateOne({ _id: rec._id, status: "paid" }, { $set: { status: "refunded" } });
      }
      return res.status(200).send("ok");
    }
    res.status(200).send("ignored");
  } catch (err) {
    console.error("Razorpay webhook error:", err.message);
    res.status(500).send("error");   // Razorpay will retry
  }
});

/* Property Operations Phase 7: a payment on a tenant's rent order. Works even if the
   tenant closed the page right after paying; recorded once, however often we hear of it. */
async function rentWebhook(type, pay, ro, res) {
  const OR = require("../utils/onlineRent");
  const RentOrder = require("../models/rentOrder");
  const matches = Number(pay.amount) === ro.amountPaise && pay.currency === "INR";
  if (type === "payment.authorized" && matches && pay.status === "authorized" && ro.status !== "paid") {
    // Razorpay holds the money but has not collected it (accounts without automatic capture): collect it.
    let p = null;
    try { p = await rzp.capturePayment(pay.id, ro.amountPaise); } catch (e) { try { p = await rzp.fetchPayment(pay.id); } catch { /* answered below */ } }
    if (!p || p.status !== "captured" || p.order_id !== pay.order_id) return res.status(503).send("not captured yet, retry");
    pay = p;
    type = "payment.captured";
  }
  if (type === "payment.captured" || type === "order.paid") {
    if (pay.status !== "captured" || !matches) {
      console.error("Razorpay webhook: rent payment does not match order", pay.order_id, pay.status, pay.amount);
      return res.status(200).send("mismatch");
    }
    // Asked again from Razorpay (a retried event can be old): still collected, and not refunded since.
    let now = null;
    try { now = await rzp.fetchPayment(pay.id); } catch (e) { return res.status(503).send("razorpay not reachable, retry"); }
    if (!now || now.status !== "captured" || Number(now.amount_refunded) >= Number(now.amount) || now.order_id !== pay.order_id || Number(now.amount) !== ro.amountPaise) {
      console.error("Razorpay webhook: rent payment no longer collected, not recorded", pay.order_id, pay.id, now && now.status);
      return res.status(200).send("not captured now");
    }
    let result;
    try { result = await OR.fulfil({ id: ro._id }, { paymentId: now.id, method: now.method || "", via: "webhook", at: now.created_at }); }
    catch (e) { console.error("ONLINE RENT: captured payment not recorded yet (will retry)", pay.order_id, pay.id, e.message); return res.status(500).send("error, retry"); }
    OR.afterPaid(result);
    if (result.ok && result.pending) return res.status(503).send("busy, retry");
    if (!result.ok) {
      // Can never be recorded (the tenant record was deleted): kept on the order for HostelNode admin, Razorpay not asked again.
      console.error("ONLINE RENT: captured payment could not be recorded", pay.order_id, pay.id, result.why);
      await RentOrder.updateOne({ _id: ro._id }, { $set: { failureReason: "Paid but not recorded: " + result.why } });
      return res.status(200).send("not recorded");
    }
    return res.status(200).send("ok");
  }
  if (type === "refund.processed" || type === "payment.refunded") {
    // Refunded in full in the Razorpay Dashboard: the rent shows as due again (the entry is cancelled, with the reason).
    if (await OR.refunded(pay)) console.log("Online rent refunded, ledger entry cancelled:", pay.id);
    return res.status(200).send("ok");
  }
  if (type === "payment.failed") {
    // Only a note: the tenant can try again on the same order.
    await RentOrder.updateOne({ _id: ro._id, status: { $in: ["created", "failed"] } },
      { $set: { status: "failed", failureReason: String(pay.error_description || pay.error_reason || "Payment failed").slice(0, 200) } });
    return res.status(200).send("ok");
  }
  return res.status(200).send("ignored");
}

/* Property Operations Phase 8: a payment on a booking. Recorded once (the student may have closed the page);
   refunds are made by HostelNode itself (utils/bookings.js), so refund events need nothing here. */
async function bookingWebhook(type, pay, bo, res) {
  const BK = require("../utils/bookings");
  const matches = Number(pay.amount) === bo.amountPaise && pay.currency === "INR";
  if (type === "payment.authorized" && matches && pay.status === "authorized" && bo.status === "pending_payment") {
    let p = null;
    try { p = await rzp.capturePayment(pay.id, bo.amountPaise); } catch (e) { try { p = await rzp.fetchPayment(pay.id); } catch { /* answered below */ } }
    if (!p || p.status !== "captured" || p.order_id !== pay.order_id) return res.status(503).send("not captured yet, retry");
    type = "payment.captured";
  }
  if (type === "payment.captured" || type === "order.paid") {
    if (!matches) { console.error("Razorpay webhook: booking payment does not match order", pay.order_id, pay.amount); return res.status(200).send("mismatch"); }
    let now = null;
    try { now = await rzp.fetchPayment(pay.id); } catch (e) { return res.status(503).send("razorpay not reachable, retry"); }
    if (!now || now.status !== "captured" || Number(now.amount_refunded) >= Number(now.amount) || now.order_id !== pay.order_id || Number(now.amount) !== bo.amountPaise) {
      return res.status(200).send("not captured now");
    }
    let result;
    try { result = await BK.fulfil({ id: bo._id }, { paymentId: now.id, method: now.method || "", via: "webhook", at: now.created_at }); }
    catch (e) { console.error("BOOKING: captured payment not recorded yet (will retry)", pay.order_id, e.message); return res.status(500).send("error, retry"); }
    BK.afterPaid(result);
    if (result.ok && result.pending) return res.status(503).send("busy, retry");
    return res.status(200).send(result.ok ? "ok" : "not recorded");
  }
  return res.status(200).send("ignored");
}

module.exports = router;
module.exports.webhook = webhook;
