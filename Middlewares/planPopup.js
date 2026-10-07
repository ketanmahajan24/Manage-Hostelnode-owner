/* ============================================================
   Middlewares/planPopup.js  —  Subscriptions: upgrade popup & drafts
   (owner dashboard only)

   Prepares, for the page about to be shown:
     • the upgrade popup (your plans with Choose buttons) when the
       owner has just been stopped at a limit or a locked feature;
     • a notice on the Add Property / Add Tenant / List Property
       forms when the owner is already at that limit;
     • the owner's saved draft, so the form can be filled back in;
     • on My Listings, any listings saved as hidden drafts.

   It only does any work on those few pages. Read-only. Fails open:
   on any error or delay the page shows as normal, with no popup.
============================================================ */

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { LIMITS, FEATURES } = require("../config/planFeatures");
const { billingOn } = require("../utils/subscription");
const { enforcementOn, checkGate } = require("../utils/planGate");

const TIME_LIMIT_MS = 1500;
const LIMIT_KEYS = new Set(LIMITS.map(l => l.key));
const FEATURE_KEYS = new Set(FEATURES.map(f => f.key));

// The three "add" forms: which limit applies, and where the form posts to.
const FORMS = {
  "/user/addnewhostel":  { limit: "maxProperties", kind: "property", action: "/user/create-hostel", what: "property" },
  "/user/newmember":     { limit: "maxTenants",    kind: "tenant",   action: "/user/newMember",     what: "tenant" },
  "/user/list-property": { limit: "maxListings",   kind: "listing",  action: "/user/new-list-property", what: "listing" },
};
const day = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

async function build(req, ownerId, key, form, isListings) {
  const out = { open: false, lock: null, plans: [], notice: "", draft: null, offer: null, held: [], form: form || null };
  const on = await enforcementOn();

  // Is the owner really stopped right now? (After upgrading, the same link shows no popup.)
  const rule = key ? (LIMIT_KEYS.has(key) ? { limit: key } : { feature: key }) : form ? { limit: form.limit } : null;
  const lock = on && rule ? await checkGate(ownerId, rule, {}) : null;

  if (lock) {
    out.lock = { title: lock.title, message: lock.message, kind: lock.kind };
    out.open = !!key;
    const info = await require("../utils/planView").loadPlanInfo(ownerId);
    const payOnline = require("../utils/razorpay").configured();
    const all = info ? info.plans.filter(p => !p.isCurrent) : [];
    // Prefer the plans that actually lift this limit or include this feature.
    const solves = p => lock.kind === "feature"
      ? p.featureKeys.includes(lock.key)
      : (p.limits[lock.key] === null || p.limits[lock.key] === undefined || Number(p.limits[lock.key]) > Number(lock.used));
    const good = all.filter(solves);
    out.plans = (good.length ? good : all).slice(0, 3).map(p => ({
      name: p.name, description: p.description, badge: p.badge, price: p.price, strikePrice: p.strikePrice, per: p.per,
      lines: p.limitLines.concat(p.features.filter(f => f.on).map(f => f.label)).slice(0, 5),
      href: payOnline && p.price > 0 ? `/user/account/checkout/${p.id}` : "/user/account/plans",
    }));
    if (form) {   // stays on the form after the popup is closed, with a button to open it again
      out.notice = form.kind === "listing"
        ? `${lock.message.split(". ")[0]}. You can still submit this listing: it will be saved as a draft, hidden from hostelnode.com until you upgrade.`
        : `${lock.message.split(". ")[0]}. You can still fill this in: it will be saved as a draft until you upgrade.`;
    }
  }

  // Saved drafts for this form (Add Property / Add Tenant).
  if (form && form.kind !== "listing") {
    const PlanDraft = require("../models/planDraft");
    const want = typeof req.query.draft === "string" && mongoose.isValidObjectId(req.query.draft) ? req.query.draft : null;
    if (want) {
      const d = await PlanDraft.findOne({ _id: want, owner: ownerId, kind: form.kind }).lean();
      if (d) out.draft = { id: String(d._id), action: form.action, fields: (d.fields || []).map(f => ({ n: f.n, v: f.v })), savedOn: day(d.createdAt) };
    }
    if (!out.draft) {
      const latest = await PlanDraft.findOne({ owner: ownerId, kind: form.kind }).sort({ createdAt: -1 }).select("_id createdAt").lean();
      if (latest) out.offer = { id: String(latest._id), savedOn: day(latest.createdAt), href: `${req.path}?draft=${latest._id}` };
    }
  }

  // Listings saved as hidden drafts.
  if (isListings) {
    const Listing = require("../models/listingProperty");
    const held = await Listing.find({ owner: ownerId, planHold: true }).select("title").sort({ createdAt: -1 }).limit(20).lean();
    out.held = held.map(l => ({ id: String(l._id), title: l.title || "Listing" }));
  }

  return (out.lock || out.draft || out.offer || out.held.length) ? out : null;
}

module.exports = async function planPopup(req, res, next) {
  res.locals.hnUpgrade = null;
  let timer;
  try {
    if (!billingOn() || process.env.HN_NEW_UI === "0" || req.method !== "GET" || !req.path.startsWith("/user")) return next();

    const path = req.path.replace(/\/+$/, "").toLowerCase();
    const form = FORMS[path] || null;
    const isListings = path === "/user/my-listings";
    let key = typeof req.query.upgrade === "string" ? req.query.upgrade : "";
    // Set by the listing form (it is sent by script, so it cannot carry ?upgrade= itself).
    // It is used up only by My Listings, the page that form goes to next.
    if (!key && isListings && req.session && req.session.hnUpgradeOnce) { key = String(req.session.hnUpgradeOnce); delete req.session.hnUpgradeOnce; }
    if (!LIMIT_KEYS.has(key) && !FEATURE_KEYS.has(key)) key = "";
    if (!key && !form && !isListings) return next();          // every other page: nothing to do

    const token = req.cookies && req.cookies.token;
    if (!token) return next();
    let ownerId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id || !mongoose.isValidObjectId(decoded.id)) return next();
      ownerId = new mongoose.Types.ObjectId(String(decoded.id));
    } catch { return next(); }

    const NONE = Symbol("none");
    const data = await Promise.race([
      build(req, ownerId, key, form, isListings),
      new Promise(resolve => { timer = setTimeout(() => resolve(NONE), TIME_LIMIT_MS); }),
    ]);
    if (data !== NONE) res.locals.hnUpgrade = data;
  } catch (err) {
    console.error("planPopup (non-fatal):", err.message);
    res.locals.hnUpgrade = null;
  }
  clearTimeout(timer);
  next();
};
