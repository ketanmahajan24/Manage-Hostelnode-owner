/* ============================================================
   Middlewares/planGate.js  —  Subscriptions Phase 4 (+ upgrade popup & drafts)

   Applies plan limits and feature locks, but only:
     • when "Enforce plan limits" is switched on in admin, and
     • on the handful of actions listed in utils/planGate.js.
   Every other request passes straight through untouched.

   What a blocked owner sees depends on the app:

   OWNER DASHBOARD (has the Plans page)
     • Add Property / Add Tenant at the limit: the form they filled is
       saved as a draft and they are returned to the form, where the
       upgrade popup opens. Nothing they typed is lost.
     • List New Property at the limit: the listing is saved as a hidden
       draft (not shown on hostelnode.com) until they upgrade and publish it.
     • A feature not in their plan: they are returned to the page they
       came from, where the upgrade popup opens.

   HOSTELNODE.COM (owner pages inside the main site)
     • A plain "upgrade your plan" page.

   Nothing is ever deleted or hidden: at a limit an owner keeps
   everything they have and simply cannot add more.

   Fails open: if the plan cannot be checked (database slow, any
   error), the action is ALLOWED. A paying owner is never locked
   out by a fault on our side.

   This file is identical in both repos. Keep them the same.
============================================================ */

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { matchRule, enforcementOn, checkGate } = require("../utils/planGate");

const TIME_LIMIT_MS = 2000;
const DRAFT_DAYS = 30;
const DRAFTS_KEPT = 5;          // per owner, per kind
const HELD_LISTINGS_MAX = 5;    // hidden draft listings one owner may keep

// Is this the owner dashboard (it has the Plans page and the popup)?
const HAS_PLANS = require("fs").existsSync(require("path").join(__dirname, "..", "routes", "planRoutes.js"));
// The popup lives in the new layout; with the old layout (HN_NEW_UI=0) the plain page is used.
const popupMode = () => HAS_PLANS && process.env.HN_NEW_UI !== "0";

// Where "View plans" goes on the plain page. In the owner dashboard this is a
// local page; on hostelnode.com set HN_OWNER_DASHBOARD_URL to the dashboard.
function plansUrl() {
  const base = String(process.env.HN_OWNER_DASHBOARD_URL || "").trim().replace(/\/$/, "");
  if (/^https:\/\/[^\s"'<>]+$/.test(base)) return base + "/user/account/plans";
  return HAS_PLANS ? "/user/account/plans" : "";
}

// The submitted form as a flat list of { n: field name, v: value }.
// Only plain text is kept: no files, nothing nested deeper than name[sub].
function formFields(body) {
  const out = [];
  const add = (n, v) => {
    if (out.length >= 60 || typeof v !== "string") return;
    if (n.length > 80 || /[$.\0]/.test(n)) return;
    if (/aadha?r/i.test(n)) return;                    // ID numbers are not kept in a draft; the owner types it again
    out.push({ n, v: v.slice(0, 500) });
  };
  if (!body || typeof body !== "object") return out;
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (typeof v === "string") add(k, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k2 of Object.keys(v)) add(`${k}[${k2}]`, v[k2]);
    }
  }
  return out;
}

async function saveDraft(req, ownerId, rule) {
  const PlanDraft = require("../models/planDraft");
  const fields = formFields(req.body);
  if (!fields.length) return null;
  const hostel = req.session && req.session.selectedHostel && mongoose.isValidObjectId(String(req.session.selectedHostel._id || req.session.selectedHostel))
    ? String(req.session.selectedHostel._id || req.session.selectedHostel) : null;
  const draft = await PlanDraft.create({
    owner: ownerId, kind: rule.kind, fields, hostel,
    expireAt: new Date(Date.now() + DRAFT_DAYS * 24 * 60 * 60 * 1000),
  });
  // Keep only the newest few.
  const old = await PlanDraft.find({ owner: ownerId, kind: rule.kind }).sort({ createdAt: -1 }).skip(DRAFTS_KEPT).select("_id").lean();
  if (old.length) await PlanDraft.deleteMany({ _id: { $in: old.map(d => d._id) } });
  return draft;
}

module.exports = async function planGate(req, res, next) {
  let timer;
  try {
    const rule = matchRule(req.method, req.path);
    if (!rule) return next();

    const token = req.cookies && req.cookies.token;
    if (!token) return next();                       // not logged in: the route's own check handles it
    let ownerId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id || !mongoose.isValidObjectId(decoded.id)) return next();
      ownerId = new mongoose.Types.ObjectId(String(decoded.id));
    } catch { return next(); }

    const OWNER_APP = popupMode();
    const isGet = req.method === "GET" || req.method === "HEAD";
    // In the owner dashboard the three "add" forms always open: the limit is
    // applied when the form is submitted, so the typed form can be kept.
    const skipLimit = OWNER_APP && isGet && !!rule.limit;
    if (skipLimit && !rule.featureIfQuery) return next();

    // A form refilled from a draft carries that draft's id. The draft is
    // removed only after the property / tenant was really created.
    const usedDraft = OWNER_APP && !isGet && (rule.kind === "property" || rule.kind === "tenant")
      && typeof req.query.hnDraft === "string" && mongoose.isValidObjectId(req.query.hnDraft) ? req.query.hnDraft : null;
    const forgetDraftOnSuccess = () => {
      if (!usedDraft) return;
      res.once("finish", () => {
        if (res.statusCode >= 400) return;           // the create failed: keep the draft
        require("../models/planDraft").deleteOne({ _id: usedDraft, owner: ownerId, kind: rule.kind }).catch(() => {});
      });
    };

    const TIMEOUT = Symbol("timeout");
    let enforced = false;
    const blocked = await Promise.race([
      enforcementOn().then(on => { enforced = on; return on ? checkGate(ownerId, rule, req.query, { skipLimit }) : null; }),
      new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), TIME_LIMIT_MS); }),
    ]);
    clearTimeout(timer);

    if (!blocked || blocked === TIMEOUT) { forgetDraftOnSuccess(); return next(); }

    const accept = req.get("accept") || "";
    const isUpload = req.method === "POST" && /multipart\/form-data/i.test(req.get("content-type") || "");
    const wantsJson = req.xhr || (/application\/json/.test(accept) && !/text\/html/.test(accept));

    if (OWNER_APP && !wantsJson) {
      if (blocked.kind === "limit" && rule.kind === "listing" && !isGet) {
        // Let the listing be saved, but as a hidden draft (routes/userRoutes.js reads
        // this flag) — up to a few; beyond that it is refused like before.
        const held = await require("../models/listingProperty").countDocuments({ owner: ownerId, planHold: true }).maxTimeMS(1500);
        if (held < HELD_LISTINGS_MAX) { req.hnPlanHold = true; return next(); }
        const text = `You already have ${held} draft listings waiting. Upgrade your plan and publish them from My Listings.`;
        return res.status(403).json({ success: false, ok: false, planLocked: true, error: text, message: text });
      }
      if (blocked.kind === "limit" && !isGet && !isUpload) {
        let draft = null, t2;
        try {
          // Saving the draft must not hold the owner up: after 2 seconds they go back without one.
          draft = await Promise.race([saveDraft(req, ownerId, rule), new Promise(resolve => { t2 = setTimeout(() => resolve(null), TIME_LIMIT_MS); })]);
        } catch (err) { console.error("planGate draft (non-fatal):", err.message); }
        clearTimeout(t2);
        // Converting a lead: keep the link to the enquiry.
        const enq = req.body && typeof req.body.enquiryId === "string" && mongoose.isValidObjectId(req.body.enquiryId) ? `&enquiry=${req.body.enquiryId}` : "";
        return res.redirect(303, `${rule.form}?upgrade=${encodeURIComponent(blocked.key)}${draft ? "&draft=" + draft._id : ""}${enq}`);
      }
      if (blocked.kind === "feature" && rule.back) {
        return res.redirect(303, `${rule.back}?upgrade=${encodeURIComponent(blocked.key)}`);
      }
    }

    res.status(403);
    // Calls made by scripts (not page loads / form posts) get a short JSON answer.
    if (wantsJson || (isUpload && !/text\/html/.test(accept))) {
      const text = blocked.title + ". " + blocked.message;
      return res.json({ success: false, ok: false, planLocked: true, error: text, message: text });
    }
    return res.render("planLocked.ejs", { lock: blocked, plansUrl: plansUrl() });
  } catch (err) {
    clearTimeout(timer);
    console.error("planGate (non-fatal, action allowed):", err.message);
    if (!res.headersSent) return next();
  }
};
