/* ============================================================
   Middlewares/planBanner.js  —  Subscriptions Phase 4 (owner dashboard)

   Puts a short notice at the top of owner pages when a plan or
   trial is about to end, has just ended (grace period), or has
   ended. Only when "Remind owners before a plan ends" is on in admin.

   Read-only. Remembered for 2 minutes per login session, so normal
   page loads do no extra database work. Fails open: on any error
   or delay the page simply shows no notice.
============================================================ */

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const BillingSettings = require("../models/billingSettings");
const { billingOn, resolveOwnerPlan, DAY } = require("../utils/subscription");

const TIME_LIMIT_MS = 1000;
const REMEMBER_MS = 2 * 60 * 1000;
const SKIP_PATHS = /^\/user\/(logout|login|signup|send-otp|verify-otp|secure\/|forgot-password|reset-password|account\/checkout)/;

const day = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const days = n => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

// The notice for this plan state, or null for "nothing to say".
function bannerFor(plan, now = new Date()) {
  if (plan.state === "trial" && plan.daysLeft !== null && plan.daysLeft <= 7) {
    return { tone: "warn", text: `Your free trial ends ${days(plan.daysLeft)}. Choose a plan to keep everything running.`, cta: "View plans" };
  }
  if (plan.state === "active" && plan.daysLeft !== null && plan.daysLeft <= 7) {
    return { tone: "warn", text: `Your ${plan.name} plan ends ${days(plan.daysLeft)} (${day(plan.expiresAt)}).`, cta: "Renew" };
  }
  if (plan.state === "grace") {
    return { tone: "bad", text: `Your ${plan.name} plan expired on ${day(plan.expiresAt)}. You keep it until ${day(plan.graceEndsAt)}.`, cta: "Renew now" };
  }
  // On the free plan after a plan ended: mention it for 30 days, then stop.
  if (plan.state === "default" && plan.expired && plan.expired.expiresAt && (now - new Date(plan.expired.expiresAt)) < 30 * DAY) {
    return { tone: "bad", text: `Your ${plan.expired.name} plan has ended. You are now on the ${plan.name} plan.`, cta: "Upgrade" };
  }
  return null;
}

async function load(ownerId) {
  const settings = await BillingSettings.read();
  if (!settings.remindersEnabled) return null;
  return bannerFor(await resolveOwnerPlan(ownerId));
}

module.exports = async function planBanner(req, res, next) {
  res.locals.hnPlanBanner = null;
  let timer;
  try {
    if (!billingOn() || process.env.HN_NEW_UI === "0" || req.method !== "GET") return next();
    if (!req.path.startsWith("/user") || SKIP_PATHS.test(req.path)) return next();
    const token = req.cookies && req.cookies.token;
    if (!token) return next();
    let ownerId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id || !mongoose.isValidObjectId(decoded.id)) return next();
      ownerId = String(decoded.id);
    } catch { return next(); }

    const kept = req.session && req.session.hnBanner;
    if (kept && kept.owner === ownerId && Date.now() - kept.at < REMEMBER_MS) {
      res.locals.hnPlanBanner = kept.data || null;
      return next();
    }

    const NONE = Symbol("none");
    const data = await Promise.race([
      load(new mongoose.Types.ObjectId(ownerId)),
      new Promise(resolve => { timer = setTimeout(() => resolve(NONE), TIME_LIMIT_MS); }),
    ]);
    if (data !== NONE) {
      res.locals.hnPlanBanner = data;
      if (req.session) req.session.hnBanner = { owner: ownerId, at: Date.now(), data };
    }
  } catch (err) {
    console.error("planBanner (non-fatal):", err.message);
    res.locals.hnPlanBanner = null;
  }
  clearTimeout(timer);
  next();
};

module.exports.bannerFor = bannerFor;
