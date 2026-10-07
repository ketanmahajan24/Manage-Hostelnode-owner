/* ============================================================
   routes/planDraftRoutes.js  —  Subscriptions: drafts
   Mounted at /user in app.js:
     POST /user/account/drafts/:id/delete   throw away a saved form draft
     POST /user/listing/:id/publish         publish a listing that was saved
                                            as a hidden draft at the plan limit
   Every route acts only on the logged-in owner's own records.
============================================================ */

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const { jwtAuthMiddleware } = require("../jwt.js");
const PlanDraft = require("../models/planDraft");
const Listing   = require("../models/listingProperty");
const { enforcementOn, checkGate } = require("../utils/planGate");

const validId = id => typeof id === "string" && mongoose.isValidObjectId(id);
const FORM_OF = { property: "/user/addnewhostel", tenant: "/user/newmember" };

router.post("/account/drafts/:id/delete", jwtAuthMiddleware, async (req, res) => {
  try {
    if (!validId(req.params.id) || !validId(String(req.user.id))) return res.redirect("/user");
    const d = await PlanDraft.findOneAndDelete({ _id: req.params.id, owner: req.user.id }).lean();
    res.redirect((d && FORM_OF[d.kind]) || "/user");
  } catch (err) {
    console.error("Draft delete error:", err.message);
    res.redirect("/user");
  }
});

router.post("/listing/:id/publish", jwtAuthMiddleware, async (req, res) => {
  try {
    if (!validId(req.params.id) || !validId(String(req.user.id))) return res.redirect("/user/my-listings");
    const listing = await Listing.findOne({ _id: req.params.id, owner: req.user.id, planHold: true }).select("_id").lean();
    if (!listing) return res.redirect("/user/my-listings");

    // Still at the limit? Then it stays a draft and the upgrade popup opens.
    // (If the plan cannot be checked, publishing is allowed.)
    let lock = null;
    try { if (await enforcementOn()) lock = await checkGate(new mongoose.Types.ObjectId(String(req.user.id)), { limit: "maxListings" }, {}); }
    catch (e) { console.error("Publish check (non-fatal):", e.message); }
    if (lock) return res.redirect("/user/my-listings?upgrade=maxListings");

    await Listing.updateOne({ _id: listing._id, owner: req.user.id, planHold: true }, { $set: { planHold: false, status: "Approved" } });

    // Two Publish clicks at the same moment could both get through: check
    // again now that it is live, and take this one back if the plan is exceeded.
    try {
      if (await enforcementOn()) {
        const ownerId = new mongoose.Types.ObjectId(String(req.user.id));
        const plan = await require("../utils/subscription").resolveOwnerPlan(ownerId);
        const cap = plan.state === "none" || !plan.limits ? null : plan.limits.maxListings;
        if (cap !== null && cap !== undefined) {
          const live = await Listing.countDocuments({ owner: ownerId, $or: [{ planHold: { $ne: true } }, { status: "Approved" }] });
          if (live > Number(cap)) {
            await Listing.updateOne({ _id: listing._id, owner: req.user.id }, { $set: { planHold: true, status: "Pending" } });
            return res.redirect("/user/my-listings?upgrade=maxListings");
          }
        }
      }
    } catch (e) { console.error("Publish re-check (non-fatal):", e.message); }
    res.redirect("/user/my-listings");
  } catch (err) {
    console.error("Listing publish error:", err.message);
    res.redirect("/user/my-listings");
  }
});

module.exports = router;
