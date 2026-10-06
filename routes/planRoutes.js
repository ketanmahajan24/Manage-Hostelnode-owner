/* ============================================================
   routes/planRoutes.js  —  Subscriptions Phase 2
   Mounted at /user in app.js:
     GET /user/account/plans     the plans an owner can choose from

   With Razorpay keys in .env (Phase 3) each paid plan has a Pay button
   that opens the pay page (routes/checkoutRoutes.js). Without keys the
   owner sees "Request this plan" and you activate it from admin.
   Off switch: HN_BILLING=0 sends this page back to Billing.
============================================================ */

const express = require("express");
const router  = express.Router();

const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const { loadPlanInfo } = require("../utils/planView");

const SUPPORT_EMAIL = "hostelnodehelp@gmail.com";

// Where "Request this plan" sends the owner: WhatsApp if you set
// HN_SUPPORT_WHATSAPP (10-digit number) in .env, otherwise email.
function requestLink(planName, owner) {
  const text = `Hi, I'd like the ${planName} plan for my HostelNode account (${owner.email || owner.phone || ""}).`;
  const wa = String(process.env.HN_SUPPORT_WHATSAPP || "").replace(/\D/g, "");
  if (/^\d{10}$/.test(wa)) return { href: `https://wa.me/91${wa}?text=${encodeURIComponent(text)}`, label: "Request on WhatsApp", external: true };
  return { href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Plan request: " + planName)}&body=${encodeURIComponent(text)}`, label: "Request this plan", external: false };
}

router.get("/account/plans", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    if (!user) return res.redirect("/login");
    const plan = await loadPlanInfo(user._id);
    if (!plan) return res.redirect("/user/account/billing");
    // Phase 3: with Razorpay keys set, paid plans get a Pay button; otherwise
    // (or for a free plan) the Phase 2 "Request this plan" button stays.
    const payOnline = require("../utils/razorpay").configured();
    plan.plans.forEach(p => {
      p.request = requestLink(p.name, user);
      p.payHref = payOnline && p.price > 0 ? `/user/account/checkout/${p.id}` : "";
    });
    res.render("account/plans.ejs", {
      user, plan, supportEmail: SUPPORT_EMAIL, payOnline,
      gone: req.query.gone === "1" ? "That plan is no longer available. Please choose from the plans below." : "",
    });
  } catch (err) {
    console.error("Plans page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

module.exports = router;
