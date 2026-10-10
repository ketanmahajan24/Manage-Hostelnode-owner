/* ============================================================
   routes/bookingsRoutes.js  —  Property Operations Phase 8: bookings (owner dashboard)
   Mounted at /user in app.js.

     GET  /bookings                      Requested / Accepted / Moved in / Declined & cancelled (?tab=, ?open=<id>)
     POST /bookings/:id/accept           accept with the exact bed (bed=<roomId>:<label>)
     POST /bookings/:id/decline          decline with a reason (full refund)
     POST /bookings/:id/cancel           cancel an accepted booking (full refund)
     GET  /bookings/:id/admit            move-in: the Add tenant form, filled in
     POST /listing/:id/booking           a listing's booking settings

   Only the logged-in owner's own bookings, in the selected property.
   Money moves through utils/bookings.js (shared with hostelnode.com).
============================================================ */
const express = require("express");
const router = express.Router();
const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const Booking = require("../models/booking");
const Listing = require("../models/listingProperty");
const BK = require("../utils/bookings");
const T = require("../utils/tenants");

const isId = v => typeof v === "string" && /^[0-9a-f]{24}$/i.test(v);
const clean = (s, max = 200) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "");
const PAGE = "/user/bookings";
const TABS = {
  requested: { label: "Requested", q: { status: "requested" } },
  accepted:  { label: "Accepted",  q: { status: "accepted" } },
  moved:     { label: "Moved in",  q: { status: "moved_in" } },
  closed:    { label: "Declined & cancelled", q: { status: { $in: ["declined", "cancelled", "expired"] } } },
};
const MSG = {
  accepted: "Booking accepted. The bed shows as Booked on your bed map, and the student is told.",
  declined: "Booking declined. The full amount is being refunded to the student.",
  cancelled: "Booking cancelled. The full amount is being refunded to the student.",
  settings: "Booking settings saved.",
  admitted: "Admitted. The booking amount is credited.",
  noshow: "Marked as not moved in. The bed is free again, and the booking amount is settled by your listing's rule.",
};
const go = (res, tab, k, v, open) => res.redirect(`${PAGE}?tab=${tab}${open ? "&open=" + open : ""}&${k}=${encodeURIComponent(v)}`);
const ownerName = async id => ((await Owner.findById(id, { name: 1 }).lean()) || {}).name || "owner";
const hostelOf = res => res.locals.selectedHostel && res.locals.selectedHostel._id;

router.get("/bookings", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    const hostel = hostelOf(res);
    const tab = TABS[req.query.tab] ? req.query.tab : "requested";
    const base = { owner: req.user.id, ...(hostel ? { hostel } : {}) };
    const counts = {};
    for (const k of Object.keys(TABS)) counts[k] = await Booking.countDocuments({ ...base, ...TABS[k].q });
    const list = await Booking.find({ ...base, ...TABS[tab].q }).sort(tab === "requested" ? { paidAt: 1 } : tab === "accepted" ? { moveIn: 1 } : { updatedAt: -1 }).limit(200).lean();
    // The open booking (drawer), with the beds the owner can pick.
    let open = null, beds = [];
    if (isId(String(req.query.open || ""))) {
      open = await Booking.findOne({ _id: req.query.open, owner: req.user.id, status: { $ne: "pending_payment" } }).lean();
      if (open && open.status === "requested") beds = await BK.bedOptions(open);
    }
    // This owner's listings that can take bookings (linked to a property), for the settings links.
    const listings = await Listing.find({ owner: req.user.id, linkedHostel: { $ne: null } }, { title: 1, booking: 1, linkedHostel: 1 }).lean();
    const ready = require("../utils/payouts").canReceive(await require("../models/payoutAccount").findOne({ owner: req.user.id }).lean());
    res.set("Cache-Control", "no-store");
    res.render("bookings/index.ejs", {
      user, tab, TABS, counts, list, open, beds, listings, ready, BK, T, now: new Date(),
      sameHostel: !open || !hostel || String(open.hostel) === String(hostel),
      flash: { msg: MSG[req.query.msg] || "", err: clean(req.query.err || "", 240) },
    });
  } catch (err) {
    console.error("Bookings page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/bookings/:id/accept", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const id = String(req.params.id);
  if (!isId(id)) return res.status(404).send("Booking not found.");
  try {
    await BK.accept({ id, ownerId: req.user.id, bed: String(req.body.bed || ""), byName: await ownerName(req.user.id) });
    go(res, "accepted", "msg", "accepted");
  } catch (err) {
    if (err.code) return go(res, "requested", "err", err.message, id);
    console.error("Booking accept error:", err.message);
    go(res, "requested", "err", "That could not be saved. Please try again.", id);
  }
});

// The student did not move in (from the move-in date): closed by the listing's rule, as a late cancellation.
router.post("/bookings/:id/noshow", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const id = String(req.params.id);
  if (!isId(id)) return res.status(404).send("Booking not found.");
  try {
    const b = await Booking.findOne({ _id: id, owner: req.user.id }).lean();
    if (!b) return res.status(404).send("Booking not found.");
    if (b.status !== "accepted") return go(res, "accepted", "err", "Only an accepted booking can be marked as not moved in.", id);
    const moment = require("moment-timezone");
    if (!moment().tz("Asia/Kolkata").startOf("day").isAfter(moment(b.moveIn).tz("Asia/Kolkata").startOf("day"))) return go(res, "accepted", "err", "You can mark this from the day after the move-in date.", id);
    // Moved in after all (admitted with the normal form): credited instead.
    const m = await BK.movedInTenant(b);
    if (m) { await BK.creditOnAdmit({ id, ownerId: req.user.id, memberId: m._id }); return go(res, "moved", "msg", "admitted"); }
    await BK.close({ id, ownerId: req.user.id, kind: "cancelled", by: "owner", byName: await ownerName(req.user.id), reason: "Did not move in", mode: BK.cancelPreview(b, "student").mode });
    go(res, "closed", "msg", "noshow");
  } catch (err) {
    if (err.code) return go(res, "accepted", "err", err.message, id);
    console.error("Booking no-show error:", err.message);
    go(res, "closed", "err", "Saved, but Razorpay could not be reached yet. It is tried again automatically.");
  }
});

router.post("/bookings/:id/:what(decline|cancel)", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const id = String(req.params.id), what = req.params.what;
  if (!isId(id)) return res.status(404).send("Booking not found.");
  const reason = clean(req.body.reason || "", 200);
  const from = what === "decline" ? "requested" : "accepted";
  if (reason.length < 3) return go(res, from, "err", "Give a short reason (the student sees it).", id);
  try {
    const b = await Booking.findOne({ _id: id, owner: req.user.id }, { status: 1 }).lean();
    if (!b) return res.status(404).send("Booking not found.");
    if (what === "decline" && b.status !== "requested") return go(res, from, "err", "Only a booking waiting for your answer can be declined.", id);
    if (what === "cancel" && b.status !== "accepted") return go(res, from, "err", "Only an accepted booking can be cancelled here.", id);
    await BK.close({ id, ownerId: req.user.id, kind: what === "decline" ? "declined" : "cancelled", by: "owner", byName: await ownerName(req.user.id), reason, mode: "full" });
    go(res, "closed", "msg", what === "decline" ? "declined" : "cancelled");
  } catch (err) {
    if (err.code) return go(res, from, "err", err.message, id);
    console.error("Booking close error:", err.message);
    go(res, "closed", "err", "Saved, but the refund could not be sent to Razorpay yet. It is tried again automatically.");
  }
});

// Move-in: the Add tenant form with everything filled in (in the booking's property).
router.get("/bookings/:id/admit", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const id = String(req.params.id);
  if (!isId(id)) return res.status(404).send("Booking not found.");
  const b = await Booking.findOne({ _id: id, owner: req.user.id }, { status: 1, hostel: 1, member: 1 }).lean();
  if (!b) return res.status(404).send("Booking not found.");
  if (b.status === "moved_in" && b.member) return res.redirect(`/user/tenants/${b.member}`);
  if (b.status !== "accepted") return go(res, "accepted", "err", "Only an accepted booking can be admitted.", id);
  if (String(hostelOf(res) || "") !== String(b.hostel)) return res.redirect(`/user/hostel/${b.hostel}?next=${encodeURIComponent("/user/newmember?booking=" + id)}`);
  res.redirect(`/user/newmember?booking=${id}`);
});

// A listing's booking settings (from the listing's link page).
router.post("/listing/:id/booking", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const id = String(req.params.id);
  const url = `/user/listing/${encodeURIComponent(id)}/link`;
  try {
    if (!isId(id)) return res.status(404).send("Listing not found.");
    const listing = await Listing.findOne({ _id: id, owner: req.user.id }, { linkedHostel: 1 }).lean();
    if (!listing) return res.status(404).send("Listing not found.");
    const b = req.body || {};
    const on = b.on === "1";
    const amountType = b.amountType === "fixed" ? "fixed" : "rent";
    const amount = Math.round(Number(String(b.amount || "0").replace(/[,₹\s]/g, "")));
    const days = Math.round(Number(b.refundDays));
    const err = m => res.redirect(`${url}?err=${encodeURIComponent(m)}#booking`);
    if (on && !listing.linkedHostel) return err("Link this listing to your property first, so students book real free beds.");
    if (amountType === "fixed" && (!Number.isFinite(amount) || amount < BK.MIN_AMOUNT || amount > 200000)) return err(`Enter a booking amount from ₹${BK.MIN_AMOUNT} to ₹2,00,000.`);
    if (!Number.isInteger(days) || days < 0 || days > 60) return err("Enter the days before move-in from 0 to 60.");
    await Listing.updateOne({ _id: id, owner: req.user.id }, { $set: { booking: {
      on, amountType, amount: amountType === "fixed" ? amount : 0,
      countsTowards: b.countsTowards === "deposit" ? "deposit" : "rent",
      refundAfter: ["full", "half", "none"].includes(b.refundAfter) ? b.refundAfter : "half", refundDays: days,
    } } });
    res.redirect(`${url}?msg=booking#booking`);
  } catch (err) {
    console.error("Booking settings error:", err.message);
    res.redirect(`${url}?err=${encodeURIComponent("The booking settings could not be saved. Please try again.")}#booking`);
  }
});

module.exports = router;
