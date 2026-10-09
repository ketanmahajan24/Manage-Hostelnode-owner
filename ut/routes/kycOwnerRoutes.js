/* ============================================================
   routes/kycOwnerRoutes.js  —  Property Operations Phase 4 (DigiLocker KYC), owner dashboard
   Mounted at /user in app.js.

     GET  /kyc/status?mobile=…   KYC of a mobile number (badge; details only when this owner may see them)
     POST /kyc/request           "Ask to verify": opens the owner's WhatsApp with the hostelnode.com/kyc link
     POST /kyc/start             "Verify on this phone": opens DigiLocker for that mobile number
     GET  /kyc/return?vid=…      back from DigiLocker (on the owner's phone)

   Who may see a person's verified name, date of birth and last 4 digits:
   only an owner the person shared them with — by verifying through that
   owner's link, by tapping "Share" on hostelnode.com/kyc, or by verifying
   on that owner's phone in person. Anyone else only sees the badge.
============================================================ */
const express = require("express");
const router = express.Router();
const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const KycSession = require("../models/kycSession");
const kyc = require("../utils/kyc");

const mainSite = () => String(process.env.HN_MAIN_SITE_URL || "https://hostelnode.com").trim().replace(/\/$/, "");
function ownerSite(req) {
  const set = String(process.env.HN_OWNER_DASHBOARD_URL || "").trim().replace(/\/$/, "");
  if (/^https?:\/\/[^\s"'<>]+$/.test(set)) return set;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}
const clean = (s, max = 100) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").trim().replace(/<[^>]*>/g, "").slice(0, max) : "");

/** What the owner pages show for one mobile number. Details only when the person shared them with this owner. */
async function viewFor(ownerId, phone) {
  const p = kyc.phoneOf(phone);
  const s = await kyc.settings();
  if (!p) return { badge: kyc.badgeOf(null), details: null, shared: false, required: s.enforced, ready: s.ready };
  const r = await kyc.recordFor(p);
  const badge = kyc.badgeOf(r, ownerId);
  const shared = kyc.sharedWith(r, ownerId);
  const details = badge.key === "verified" && shared ? {
    name: r.name, dob: kyc.dobText(r.dob, r.dobYearOnly), dobIso: r.dob && !r.dobYearOnly ? require("moment-timezone")(r.dob).tz("Asia/Kolkata").format("YYYY-MM-DD") : "",
    gender: r.gender, state: r.state, last4: r.last4, verifiedAt: kyc.dobText(r.verifiedAt), via: r.via,
    // Verified on an owner's phone with an Aadhaar whose linked mobile is a different number.
    otherMobile: r.via === "owner" && r.mobileMatch === false,
  } : null;
  const asked = r && (r.requests || []).find(x => String(x.owner) === String(ownerId));
  return { badge, details, shared, required: s.enforced, ready: s.ready, askedAt: asked ? asked.at : null };
}

router.get("/kyc/status", jwtAuthMiddleware, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    await kyc.catchUp(req.query.mobile);   // an attempt whose return page was never opened
    res.json(await viewFor(req.user.id, req.query.mobile));
  } catch (err) {
    console.error("KYC status error:", err.message);
    res.status(500).json({ error: "Could not check KYC right now." });
  }
});

// "Ask to verify": the message goes from the owner's own WhatsApp (no template needed).
router.post("/kyc/request", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = req.body.member || {};   // (sent from the Add tenant form)
    const p = kyc.phoneOf(req.body.mobile || m.mobileNo);
    if (!p) return res.status(400).send("Enter a 10-digit mobile number first.");
    await kyc.noteRequest(p, req.user.id);
    const hostel = res.locals.selectedHostel;
    const first = clean(req.body.name || m.name || "", 60).split(" ")[0];
    const link = `${mainSite()}/kyc${hostel && hostel._id ? "?p=" + hostel._id : ""}`;
    const text = `Hi${first ? " " + first : ""}, please verify your Aadhaar for ${hostel && hostel.hostelName ? hostel.hostelName : "your PG"} on HostelNode. It takes about a minute with DigiLocker (Aadhaar OTP): ${link}`;
    const wa = `https://wa.me/91${p}?text=${encodeURIComponent(text)}`;
    if (String(req.headers.accept || "").includes("application/json")) return res.json({ wa, view: await viewFor(req.user.id, p) });
    res.redirect(wa);
  } catch (err) {
    console.error("KYC request error:", err.message);
    res.status(500).send("That could not be done. Please try again.");
  }
});

// "Verify on this phone": DigiLocker opens here; the tenant signs in with their own Aadhaar OTP.
router.post("/kyc/start", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const s = await kyc.settings();
    if (!s.ready) return res.status(503).send("DigiLocker KYC is not switched on yet.");
    const p = kyc.phoneOf(req.body.mobile || (req.body.member || {}).mobileNo);
    if (!p) return res.status(400).send("Enter the tenant's 10-digit mobile number first.");
    // Verified by the person themselves, or already on this owner's phone: nothing to redo here.
    // (A check done on another owner's phone does not count for this owner, so it can be done here too.)
    const existing = await kyc.recordFor(p);
    if (existing && existing.status === "verified" && (existing.via === "student" || kyc.sharedWith(existing, req.user.id))) return res.status(409).send("This mobile number is already KYC verified. Ask the tenant to share the details with you from the link (Ask to verify).");
    const { url } = await kyc.start({ phone: p, via: "owner", ownerId: req.user.id, hostelId: res.locals.selectedHostel ? res.locals.selectedHostel._id : null,
      returnUrl: `${ownerSite(req)}/user/kyc/return` });
    res.redirect(url);
  } catch (err) {
    console.error("KYC start (owner) error:", err.message);
    res.status(502).send(err.code === "not_configured" ? "DigiLocker KYC is not switched on yet." : "DigiLocker could not be opened right now. Please try again in a minute.");
  }
});

// Back from DigiLocker. The login cookie is not sent on a link coming from another site
// (SameSite), so this page works without it: it only finishes the check and says whether
// it worked — no personal details — then the owner goes back to the form (logged in again).
router.get("/kyc/return", async (req, res) => {
  try {
    const vid = String(req.query.vid || req.query.verification_id || "");
    const session = /^[A-Za-z0-9._-]{1,50}$/.test(vid) ? await KycSession.findById(vid).lean() : null;
    if (!session || session.via !== "owner") return res.status(404).send("This verification was not found.");
    const out = await kyc.finish(vid);
    const tries = Math.min(20, Math.max(0, parseInt(req.query.t, 10) || 0));
    res.set("Cache-Control", "no-store");
    res.render("kyc/ownerReturn.ejs", { out, vid, tries });
  } catch (err) {
    console.error("KYC return (owner) error:", err.message);
    res.status(500).send("Something went wrong. Please check the tenant's KYC again from the form.");
  }
});

module.exports = router;
module.exports.viewFor = viewFor;
