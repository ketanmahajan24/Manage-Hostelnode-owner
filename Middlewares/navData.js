/* ============================================================
   Middlewares/navData.js  —  Phase 1 (new navbar shell)

   Adds the small numbers the new navbar shows on every owner page:
     • unread Messages badge
     • "N NEW" enquiries badge on Leads & CRM
     • unread notifications dot on the bell
     • "SETUP n/4" chip in the top bar

   Read-only. Never writes to the database.
   Fails open: if anything here throws or the token is missing/invalid,
   the page still renders — just without badges. It never redirects,
   never blocks a request, and never changes req.user.
============================================================ */

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Conversation = require("../models/Conversation");
const Listing      = require("../models/listingProperty");
const Enquiry      = require("../models/enquiry");
const Notification = require("../models/Notification");
const Hostel       = require("../models/hostel");
const Floor        = require("../models/floor");
const Room         = require("../models/room");
const Member       = require("../models/member");

// Setup steps shown by the "SETUP n/4" chip, in order.
// `href` is where the chip sends the owner for the first unfinished step.
const SETUP_STEPS = [
  { key: "property", label: "Add your property", href: "/user/addnewhostel" },
  { key: "floor",    label: "Add a floor",       href: "/user/newfloor" },
  { key: "room",     label: "Add a room",        href: "/user/newroom" },
  { key: "tenant",   label: "Add a tenant",      href: "/user/newmember" },
];

// Not pages: skip them so they pay nothing.
const SKIP_PATHS = /^\/user\/(logout|login|signup|send-otp|verify-otp|secure\/|forgot-password|reset-password)/;
const POST_PAGES = new Set(["/user/member/search", "/user/searchfeesrecords"]);

// Hard ceiling on how long badges may delay a page. Each query also gets
// maxTimeMS so a slow database gives up server-side too.
const TIME_LIMIT_MS = 1000;

const EMPTY = {
  unreadMessages: 0,
  newEnquiries: 0,
  unreadNotifications: 0,
  newBookings: 0,   // Property Operations Phase 8: bookings waiting for the owner's answer
  setup: { done: SETUP_STEPS.length, total: SETUP_STEPS.length, next: null },
};

async function countUnreadMessages(ownerId) {
  // unreadCounts is a Map stored as { "<ownerId>": n, ... }; project
  // just this owner's entry and add them up.
  const key = `unreadCounts.${ownerId.toString()}`;
  const convs = await Conversation.find(
    { type: "PG_INQUIRY", ownerParticipant: ownerId },
    { [key]: 1 }
  ).maxTimeMS(TIME_LIMIT_MS).lean();
  return convs.reduce((sum, c) => sum + (Number(c.unreadCounts?.[ownerId.toString()]) || 0), 0);
}

async function countNewEnquiries(ownerId) {
  const listingIds = (await Listing.find({ owner: ownerId }, { _id: 1 }).maxTimeMS(TIME_LIMIT_MS).lean()).map(l => l._id);
  if (!listingIds.length) return 0;
  return Enquiry.countDocuments({ listing: { $in: listingIds }, status: "New" }).maxTimeMS(TIME_LIMIT_MS);
}

async function countUnreadNotifications(ownerId) {
  return Notification.countDocuments({ user: ownerId, userModel: "Owner", isRead: false }).maxTimeMS(TIME_LIMIT_MS);
}

async function setupProgress(ownerId) {
  const [hasProperty, hasFloor, hasRoom, hasTenant] = await Promise.all([
    Hostel.exists({ owner: ownerId }).maxTimeMS(TIME_LIMIT_MS),
    Floor.exists({ user: ownerId }).maxTimeMS(TIME_LIMIT_MS),
    Room.exists({ user: ownerId }).maxTimeMS(TIME_LIMIT_MS),
    Member.exists({ user: ownerId }).maxTimeMS(TIME_LIMIT_MS),
  ]);
  const flags = [hasProperty, hasFloor, hasRoom, hasTenant].map(Boolean);
  const done = flags.filter(Boolean).length;
  const firstMissing = flags.indexOf(false);
  return {
    done,
    total: SETUP_STEPS.length,
    next: firstMissing === -1 ? null : SETUP_STEPS[firstMissing],
  };
}

// Run a count, and fall back to a default if it fails — one broken
// count must never hide the others or break the page.
async function safe(fn, fallback) {
  try { return await fn(); } catch (err) {
    console.error("navData (non-fatal):", err.message);
    return fallback;
  }
}

module.exports = async function navData(req, res, next) {
  res.locals.hn2 = EMPTY;
  let timer;
  try {
    // Whichever finishes first: the counts, or the time limit (page then
    // renders without badges). A late result is simply ignored.
    await Promise.race([
      fill(req, res),
      new Promise(resolve => { timer = setTimeout(resolve, TIME_LIMIT_MS); }),
    ]);
  } catch (err) {
    console.error("navData (non-fatal):", err.message);
    res.locals.hn2 = EMPTY;
  }
  clearTimeout(timer);
  next();
};

async function fill(req, res) {

  // Old navbar in use (rollback switch) — it shows no badges.
  if (process.env.HN_NEW_UI === "0") return;
  // Only owner pages that render HTML need this: page loads (GET) and the
  // two form posts that render a page.
  if (!req.path.startsWith("/user") || SKIP_PATHS.test(req.path)) return;
  const wantsPage = req.method === "GET" || (req.method === "POST" && POST_PAGES.has(req.path));
  if (!wantsPage) return;

  const token = req.cookies?.token;
  if (!token) return;

  let ownerId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id || !mongoose.isValidObjectId(decoded.id)) return;
    ownerId = new mongoose.Types.ObjectId(String(decoded.id));
  } catch {
    return; // the route's own auth middleware decides what to do
  }

  const [unreadMessages, newEnquiries, unreadNotifications, setup, newBookings] = await Promise.all([
    safe(() => countUnreadMessages(ownerId), 0),
    safe(() => countNewEnquiries(ownerId), 0),
    safe(() => countUnreadNotifications(ownerId), 0),
    safe(() => setupProgress(ownerId), EMPTY.setup),
    safe(() => require("../models/booking").countDocuments({ owner: ownerId, status: "requested" }), 0),   // Phase 8
  ]);

  if (!res.headersSent) res.locals.hn2 = { unreadMessages, newEnquiries, unreadNotifications, setup, newBookings };
}
