/* ============================================================
   Middlewares/welcome.js  —  welcome popup after signup

   Signup logs the new owner in and marks their session. On their
   first dashboard page this prepares a one-time welcome popup that
   tells them which plan they are on (their free trial, or the free
   plan) and where to manage billing. Shown once, then never again.

   Read-only. Fails open: on any error the page shows as normal.
============================================================ */

const jwt = require("jsonwebtoken");

module.exports = async function welcome(req, res, next) {
  try {
    if (req.method !== "GET" || !req.session || !req.session.hnWelcome) return next();
    if (req.path !== "/user" && req.path !== "/user/") return next();
    if (process.env.HN_NEW_UI === "0") return next();   // the popup lives in the new layout
    const marked = String(req.session.hnWelcome);
    delete req.session.hnWelcome;                       // once only

    const token = req.cookies && req.cookies.token;
    if (!token) return next();
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return next(); }
    if (!decoded || String(decoded.id) !== marked) return next();

    // The plan card is optional: with subscriptions switched off the popup is a plain welcome.
    let plan = null;
    try { plan = await require("../utils/planView").loadPlanInfo(decoded.id); } catch { plan = null; }
    res.locals.hnWelcome = { plan: plan && plan.show ? plan : null };
  } catch (err) {
    console.error("welcome (non-fatal):", err.message);
  }
  next();
};
