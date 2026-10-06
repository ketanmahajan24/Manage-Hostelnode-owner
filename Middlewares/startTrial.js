/* ============================================================
   Middlewares/startTrial.js  —  Subscriptions Phase 2

   Starts an owner's free trial the first time they open a
   dashboard page after you switch "Start free trials" on in the
   admin panel (it can take up to a minute to notice the switch).
   While trials are off it does no database work; once an owner has
   a plan record it stops checking for that login session.

   Fails open: if anything here goes wrong or takes too long, the
   page loads normally and the check simply runs again next time.
   It never redirects, never blocks, never changes req.user.
============================================================ */

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { billingOn, ensureTrial } = require("../utils/subscription");

const Plan            = require("../models/plan");
const BillingSettings = require("../models/billingSettings");

const TIME_LIMIT_MS = 1000;

// Are trials switched on, with a Trial plan to give? Looked up at most
// once a minute for the whole app, so while trials are off (the default)
// owner pages do no extra database work at all.
const OPEN_TTL_MS = Number(process.env.HN_TRIAL_CACHE_MS) || 60 * 1000;   // env override is for tests only
let openCache = { at: 0, open: false };
async function trialsOpen() {
  if (Date.now() - openCache.at < OPEN_TTL_MS) return openCache.open;
  openCache = { at: Date.now(), open: openCache.open };   // one refresh at a time
  try {
    const settings = await BillingSettings.read();
    const open = !!settings.trialsEnabled && !!(await Plan.exists({ role: "trial", archivedAt: null }).maxTimeMS(TIME_LIMIT_MS));
    openCache = { at: Date.now(), open };
  } catch (err) {
    console.error("startTrial (non-fatal):", err.message);
  }
  return openCache.open;
}
const SKIP_PATHS = /^\/user\/(logout|login|signup|send-otp|verify-otp|secure\/|forgot-password|reset-password)/;

module.exports = async function startTrial(req, res, next) {
  let timer;
  try {
    if (!billingOn() || req.method !== "GET") return next();
    if (!req.path.startsWith("/user") || SKIP_PATHS.test(req.path)) return next();
    const token = req.cookies && req.cookies.token;
    if (!token) return next();

    let ownerId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id || !mongoose.isValidObjectId(decoded.id)) return next();
      ownerId = String(decoded.id);
    } catch { return next(); }   // the route's own login check decides what to do

    if (req.session && req.session.hnTrialChecked === ownerId) return next();


    let settled = false;
    await Promise.race([
      trialsOpen().then(open => (open ? ensureTrial(new mongoose.Types.ObjectId(ownerId)) : false)).then(done => { settled = done === true; }),
      new Promise(resolve => { timer = setTimeout(resolve, TIME_LIMIT_MS); }),
    ]);
    // Stop checking for this session only once the owner has a plan record.
    // Until then (trials still off, or no Trial plan yet) keep checking, so
    // the trial starts on the first visit after you switch trials on.
    if (settled && req.session) req.session.hnTrialChecked = ownerId;
  } catch (err) {
    console.error("startTrial (non-fatal):", err.message);
  }
  clearTimeout(timer);
  next();
};
