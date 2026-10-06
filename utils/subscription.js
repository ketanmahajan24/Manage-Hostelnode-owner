/* ============================================================
   utils/subscription.js  —  Subscriptions Phase 2-3

   Works out which plan an owner is on, and holds the few actions
   that change it (start trial, grant, extend, cancel).

   This file is identical in both repos (hostelnode.com and the
   owner dashboard). Keep them the same.

   Nothing here locks or blocks anything: enforcement is Phase 4.
============================================================ */

const mongoose = require("mongoose");
const Plan            = require("../models/plan");
const Subscription    = require("../models/subscription");
const BillingSettings = require("../models/billingSettings");
const { LIMITS, FEATURES } = require("../config/planFeatures");

const DAY = 24 * 60 * 60 * 1000;
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

const billingOn = () => process.env.HN_BILLING !== "0";

// start + "1 month" / "30 days" / "1 year"  →  the expiry moment
function addDuration(start, duration) {
  const value = Math.max(1, Number(duration && duration.value) || 1);
  const unit  = duration && duration.unit;
  const d = new Date(start);
  if (unit === "day") return new Date(d.getTime() + value * DAY);
  const months = unit === "year" ? value * 12 : value;
  // Do the calendar maths on the India date (so "1 March, 1 am" + 1 month
  // is 1 April, 1 am in India), then convert back.
  const ist = new Date(d.getTime() + IST_OFFSET);
  const day = ist.getUTCDate();
  ist.setUTCDate(1);
  ist.setUTCMonth(ist.getUTCMonth() + months);
  // 31 Jan + 1 month → 28/29 Feb, not 3 Mar
  const lastDay = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0)).getUTCDate();
  ist.setUTCDate(Math.min(day, lastDay));
  return new Date(ist.getTime() - IST_OFFSET);
}

// The copy of a plan stored on a subscription.
function snapshotOf(plan) {
  const limits = {}, features = {};
  LIMITS.forEach(l => { const v = plan.limits && plan.limits[l.key]; limits[l.key] = (v === null || v === undefined) ? null : Number(v); });
  FEATURES.forEach(f => { features[f.key] = !!(plan.features && plan.features[f.key]); });
  return {
    name: plan.name, description: plan.description || "", price: Number(plan.price) || 0,
    duration: { value: plan.duration && plan.duration.value, unit: plan.duration && plan.duration.unit },
    limits, features, displayPoints: (plan.displayPoints || []).slice(0, 10), role: plan.role || "normal",
  };
}

const livePlan = role => Plan.findOne({ role, archivedAt: null }).lean();

/* ── Start the free trial ─────────────────────────────────────
   Runs the first time an owner is seen after this update. Does
   nothing unless "Start free trials" is switched on in admin, and
   nothing if the owner already has any subscription record (so a
   trial is given once, ever) or if no Trial plan exists. Safe to call repeatedly and from two requests at once. */
async function ensureTrial(ownerId, now = new Date()) {
  if (!billingOn()) return false;
  // Returns true once the owner has a plan record (nothing more to check
  // for them), false while there is still nothing to give.
  if (await Subscription.exists({ owner: ownerId }).maxTimeMS(2000)) return true;
  const settings = await BillingSettings.read();
  if (!settings.trialsEnabled) return false;        // you have not switched trials on yet
  const plan = await livePlan("trial");
  if (!plan) return false;
  // Only a real owner account that is not banned can start a trial.
  const Owner = require("../models/owner");
  if (!(await Owner.exists({ _id: ownerId, status: { $ne: "Banned" } }))) return false;
  try {
    await Subscription.create({
      owner: ownerId, plan: plan._id, snapshot: snapshotOf(plan),
      source: "trial", status: "active", trialKey: String(ownerId),
      startsAt: now, expiresAt: addDuration(now, plan.duration),
    });
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;    // 11000 = another request created it first
  }
  return true;
}

/* ── Which plan is this owner on right now? ───────────────────
   state:
     "trial"    on the free trial
     "active"   on a plan you granted or they paid for
     "grace"    plan expired, still inside the grace days
     "default"  no current plan → your Default (free) plan applies
     "none"     no current plan and no Default plan exists yet
   Read-only. */
async function resolveOwnerPlan(ownerId, now = new Date()) {
  const [sub, settings] = await Promise.all([
    Subscription.findOne({ owner: ownerId, status: "active" }).sort({ startsAt: -1, _id: -1 }).lean(),
    BillingSettings.read(),
  ]);
  const graceDays = Math.max(0, Number(settings.graceDays) || 0);

  if (sub) {
    const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
    const base = {
      subscription: sub, planId: String(sub.plan), name: sub.snapshot.name,
      limits: sub.snapshot.limits || {}, features: sub.snapshot.features || {},
      startsAt: sub.startsAt, expiresAt: exp, graceDays,
    };
    if (!exp || now <= exp) {
      // A Trial plan you give by hand from admin counts as a trial too.
      const isTrial = sub.source === "trial" || (sub.snapshot && sub.snapshot.role === "trial");
      return { ...base, state: isTrial ? "trial" : "active",
               daysLeft: exp ? Math.max(0, Math.ceil((exp - now) / DAY)) : null, graceEndsAt: null };
    }
    const graceEndsAt = new Date(exp.getTime() + graceDays * DAY);
    if (now <= graceEndsAt) {
      return { ...base, state: "grace", daysLeft: 0, graceEndsAt,
               graceDaysLeft: Math.max(0, Math.ceil((graceEndsAt - now) / DAY)) };
    }
  }

  const fallback = await livePlan("default");
  const expired = sub ? { name: sub.snapshot.name, expiresAt: sub.expiresAt, source: sub.source } : null;
  if (!fallback) {
    return { state: "none", subscription: null, planId: null, name: "No plan", limits: {}, features: {},
             startsAt: null, expiresAt: null, daysLeft: null, graceEndsAt: null, graceDays, expired };
  }
  const snap = snapshotOf(fallback);
  return { state: "default", subscription: null, planId: String(fallback._id), name: snap.name,
           limits: snap.limits, features: snap.features,
           startsAt: null, expiresAt: null, daysLeft: null, graceEndsAt: null, graceDays, expired };
}

/* ── How much of each limit the owner is using ── */
async function ownerUsage(ownerId) {
  const Hostel  = require("../models/hostel");
  const Member  = require("../models/member");
  const Listing = require("../models/listingProperty");
  const [properties, tenants, listings] = await Promise.all([
    Hostel.countDocuments({ owner: ownerId }),
    Member.countDocuments({ user: ownerId, status: "Active" }),
    Listing.countDocuments({ owner: ownerId }),
  ]);
  return { maxProperties: properties, maxTenants: tenants, maxListings: listings };
}

/* ── Admin actions ────────────────────────────────────────── */

// Keep the newest current plan of an owner and mark the rest "replaced".
// Two activations landing together both pick the same "newest", so exactly
// one plan stays current.
async function retireOlder(ownerId, fallback, adminId, now = new Date()) {
  const newest = (await Subscription.findOne({ owner: ownerId, status: "active" }).sort({ startsAt: -1, _id: -1 }).select("_id startsAt").lean()) || fallback;
  // "Older than the newest" only — never a record that arrived after we looked.
  await Subscription.updateMany(
    { owner: ownerId, status: "active",
      $or: [{ startsAt: { $lt: newest.startsAt } }, { startsAt: newest.startsAt, _id: { $lt: newest._id } }] },
    { $set: { status: "replaced", endedAt: now, endedBy: adminId || null } }
  );
}

// Give an owner a plan now. Their current plan (if any) is marked "replaced".
// days: optional custom length in days; otherwise the plan's own duration.
async function grantPlan({ ownerId, planId, adminId, days, note, source = "admin", amountPaid = 0, now = new Date() }) {
  const plan = await Plan.findOne({ _id: planId, archivedAt: null }).lean();
  if (!plan) return { ok: false, error: "That plan does not exist or is archived." };
  if (plan.role === "default") return { ok: false, error: "The Default plan applies automatically; it cannot be given by hand." };

  const expiresAt = days ? new Date(now.getTime() + days * DAY) : addDuration(now, plan.duration);
  const created = await Subscription.create({
    owner: ownerId, plan: plan._id, snapshot: snapshotOf(plan),
    source, status: "active", startsAt: now, expiresAt,
    amountPaid, note: note || "", grantedBy: adminId || null,
  });
  // Only after the new one exists: retire the older ones.
  await retireOlder(ownerId, created, adminId, now);
  return { ok: true, subscription: created };
}

// Add days to the owner's current plan. If it has already expired,
// the days count from today.
async function extendPlan({ ownerId, days, adminId, now = new Date() }) {
  // The update only applies if the expiry is still what we read, so two
  // extends at once both count and an extend never revives a cancelled plan.
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await Subscription.findOne({ owner: ownerId, status: "active" }).sort({ startsAt: -1, _id: -1 }).lean();
    if (!sub) return { ok: false, error: "This owner has no current plan to extend. Give them a plan instead." };
    if (!sub.expiresAt) return { ok: false, error: "This plan never expires." };
    const from = sub.expiresAt > now ? sub.expiresAt : now;
    const expiresAt = new Date(new Date(from).getTime() + days * DAY);
    // A new end date starts a fresh round of expiry reminders (Phase 4).
    const r = await Subscription.updateOne({ _id: sub._id, status: "active", expiresAt: sub.expiresAt }, { $set: { expiresAt, remindersSent: [] } });
    if (r.modifiedCount) return { ok: true, expiresAt };
  }
  return { ok: false, error: "This owner has no current plan to extend. Give them a plan instead." };
}

// End the owner's current plan now. They move to the Default plan.
async function cancelPlan({ ownerId, adminId, now = new Date() }) {
  const r = await Subscription.updateMany(
    { owner: ownerId, status: "active" },
    { $set: { status: "cancelled", endedAt: now, endedBy: adminId || null } }
  );
  return r.modifiedCount ? { ok: true } : { ok: false, error: "This owner has no current plan." };
}

module.exports = {
  billingOn, addDuration, snapshotOf, ensureTrial, resolveOwnerPlan, ownerUsage,
  grantPlan, extendPlan, cancelPlan, retireOlder, DAY,
};
