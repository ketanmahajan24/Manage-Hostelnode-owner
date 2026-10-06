/* ============================================================
   utils/subscriptionPayments.js  —  Subscriptions Phase 3

   What happens once a plan payment is known to be paid: the plan
   is activated and a Billing-history line is added. Used by the
   owner dashboard (browser return + Razorpay webhook) and by the
   admin panel ("Mark as paid").

   Safe to call any number of times for the same payment: the plan
   is activated once and billed once.

   This file is identical in both repos. Keep them the same.
============================================================ */

const Plan                = require("../models/plan");
const Subscription        = require("../models/subscription");
const SubscriptionPayment = require("../models/subscriptionPayment");
const { addDuration, snapshotOf, retireOlder } = require("./subscription");

const LOCK_MS = 2 * 60 * 1000;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const durationText = d => (d && d.value ? plural(Number(d.value), d.unit) : "");

// A plan an owner may pay for right now.
function findBuyablePlan(planId, now = new Date()) {
  return Plan.findOne({
    _id: planId, role: "normal", isVisible: true, archivedAt: null, price: { $gt: 0 },
    $or: [{ offerEndsAt: null }, { offerEndsAt: { $gt: now } }],
  }).lean();
}

/* When would this purchase run until?
   Renewing the same paid plan before it ends adds the new period after the
   current end date (no paid day is lost). Anything else starts today. */
async function validityFor(ownerId, planId, duration, now = new Date()) {
  const current = await Subscription.findOne({ owner: ownerId, status: "active" }).sort({ startsAt: -1, _id: -1 }).lean();
  const renewing = !!current && current.source !== "trial" && String(current.plan) === String(planId)
    && !!current.expiresAt && new Date(current.expiresAt) > now;
  const from = renewing ? new Date(current.expiresAt) : now;
  return { renewing, startsAt: now, expiresAt: addDuration(from, duration), currentEndsAt: renewing ? new Date(current.expiresAt) : null };
}

/* Mark a payment as paid and activate its plan.
   by: { razorpayOrderId } or { id }
   Returns { ok, record, subscription, fresh }  (fresh = this call did the activation)
        or { ok:false, error }                   */
async function fulfilPayment(by, { razorpayPaymentId, via, method, adminId, now = new Date() } = {}) {
  const query = by.id ? { _id: by.id } : { razorpayOrderId: String(by.razorpayOrderId || "") };
  const rec = await SubscriptionPayment.findOne(query).lean();
  if (!rec) return { ok: false, error: "unknown-order" };
  if (rec.status === "refunded") return { ok: false, error: "refunded" };
  if (rec.subscription) {
    return { ok: true, fresh: false, record: rec, subscription: await Subscription.findById(rec.subscription).lean() };
  }

  // Take a short lock so two callers (browser + webhook) do not both activate.
  const set = { status: "paid", paidAt: rec.paidAt || now, lockAt: now, via: rec.via || via || "" };
  if (razorpayPaymentId) set.razorpayPaymentId = String(razorpayPaymentId);
  if (method) set.method = String(method).slice(0, 30);
  if (adminId) set.markedBy = adminId;
  const claimed = await SubscriptionPayment.findOneAndUpdate(
    { _id: rec._id, subscription: null, status: { $ne: "refunded" },
      $or: [{ lockAt: null }, { lockAt: { $lt: new Date(now.getTime() - LOCK_MS) } }] },
    { $set: set }, { new: true }
  ).lean();
  if (!claimed) return { ok: true, fresh: false, pending: true, record: rec, subscription: null };

  try {
    const snap = claimed.snapshot || {};
    const v = await validityFor(claimed.owner, claimed.plan, snap.duration, now);
    let sub, fresh = true;
    try {
      sub = await Subscription.create({
        owner: claimed.owner, plan: claimed.plan, snapshot: snap,
        source: "razorpay", status: "active", startsAt: now, expiresAt: v.expiresAt,
        amountPaid: claimed.amount, payment: claimed._id,
        note: adminId ? "Marked as paid by admin" : "",
        grantedBy: adminId || null,
      });
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      // The database rule fired: this payment already activated a plan.
      sub = await Subscription.findOne({ payment: claimed._id });
      fresh = false;
    }
    // Billing-history line on the owner's account, once. Normally added by the
    // call that created the plan record; a later call adds it only when it is
    // finishing a job that an earlier call started and never completed.
    const recovering = !fresh && sub && sub.createdAt && (now - new Date(sub.createdAt)) > 30 * 1000;
    const bill = (fresh || recovering)
      ? await SubscriptionPayment.findOneAndUpdate({ _id: claimed._id, billed: { $ne: true } }, { $set: { billed: true } }).lean()
      : null;
    if (bill) {
      try {
        const Owner = require("../models/owner");
        await Owner.updateOne({ _id: claimed.owner }, { $push: { billingHistory: {
          amount: claimed.amount, date: now, paid: true,
          description: `${snap.name || "Plan"} plan — ${durationText(snap.duration)}`.trim(),
        } } });
      } catch (err) {
        // The plan is active and the payment is recorded; only the history line is missing.
        console.error("Billing history line (non-fatal):", err.message);
        await SubscriptionPayment.updateOne({ _id: claimed._id }, { $set: { billed: false } }).catch(() => {});
      }
    }

    // Older plans of this owner become "replaced". Not fatal if it fails: the
    // newest plan is always the one that counts.
    try { await retireOlder(claimed.owner, sub, adminId || null, now); }
    catch (err) { console.error("Retire older plans (non-fatal):", err.message); }

    const record = await SubscriptionPayment.findOneAndUpdate(
      { _id: claimed._id }, { $set: { subscription: sub._id, fulfilledAt: now, lockAt: null } }, { new: true }
    ).lean();
    return { ok: true, fresh, record, subscription: sub.toObject ? sub.toObject() : sub };
  } catch (err) {
    // Let the next caller (webhook retry, page reload, admin) try again at once.
    await SubscriptionPayment.updateOne({ _id: claimed._id, subscription: null }, { $set: { lockAt: null } }).catch(() => {});
    throw err;
  }
}

module.exports = { findBuyablePlan, validityFor, fulfilPayment, durationText, snapshotOf };
