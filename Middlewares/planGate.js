/* ============================================================
   Middlewares/planGate.js  —  Subscriptions Phase 4

   Applies plan limits and feature locks, but only:
     • when "Enforce plan limits" is switched on in admin, and
     • on the handful of actions listed in utils/planGate.js.
   Every other request passes straight through untouched.

   A blocked owner sees a clear page with a "View plans" button.
   Nothing is ever deleted or hidden: above a limit an owner keeps
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

// Where "View plans" goes. In the owner dashboard this is a local page.
// On hostelnode.com set HN_OWNER_DASHBOARD_URL to the dashboard's address.
// Returns "" when this app has no Plans page and no address is configured;
// the locked page then explains where to go instead of showing a dead button.
const HAS_PLANS_PAGE = require("fs").existsSync(require("path").join(__dirname, "..", "routes", "planRoutes.js"));
function plansUrl() {
  const base = String(process.env.HN_OWNER_DASHBOARD_URL || "").trim().replace(/\/$/, "");
  if (/^https:\/\/[^\s"'<>]+$/.test(base)) return base + "/user/account/plans";
  return HAS_PLANS_PAGE ? "/user/account/plans" : "";
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

    const TIMEOUT = Symbol("timeout");
    const blocked = await Promise.race([
      enforcementOn().then(on => (on ? checkGate(ownerId, rule, req.query) : null)),
      new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), TIME_LIMIT_MS); }),
    ]);
    clearTimeout(timer);
    if (!blocked || blocked === TIMEOUT) return next();

    res.status(403);
    // Calls made by scripts (not page loads / form posts) get a short JSON answer.
    // The "List a property" form is sent by script too (a file upload), so it gets JSON as well.
    const accept = req.get("accept") || "";
    const wantsJson = req.xhr || (/application\/json/.test(accept) && !/text\/html/.test(accept))
      || (req.method === "POST" && /multipart\/form-data/i.test(req.get("content-type") || "") && !/text\/html/.test(accept));
    if (wantsJson) {
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
