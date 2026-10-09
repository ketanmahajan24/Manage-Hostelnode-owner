/* ============================================================
   app.js  —  HostelNode Main Server
============================================================ */
require('dotenv').config();
// At the top with other requires
const userRouter = require("./routes/userRoutes.js"); // or whatever your owner router file is named

const express      = require("express");
const app          = express();
const path         = require("path");
const cookieParser = require("cookie-parser");
const bodyParser   = require("body-parser");
const methodOverride = require("method-override");
const cors         = require("cors");
const session      = require("express-session");
const ejsMate      = require("ejs-mate");
const mongoose     = require("mongoose");
const cron         = require("node-cron");
const moment       = require("moment");
const jwt          = require("jsonwebtoken");

// ── DB ──────────────────────────────────────────────────────
const connectDB = require("./config/db");
connectDB();

// ── Models ──────────────────────────────────────────────────
// Trimmed: Admin/User (superadmin panel — a different system, not
// this owner dashboard) removed, along with everything only they used.
const Student  = require("./models/studentSchema");
const Floor    = require("./models/floor.js");
const Room     = require("./models/room.js");
const Member   = require("./models/member.js");
const Payment  = require("./models/payment.js");

// ── Routes ───────────────────────────────────────────────────
// Trimmed to owner-admin (existing) + owner chat (new) only. Removed:
// publicRoutes, findHostelsRouter, studentRouter, adminRouter,
// cityRouter, flatmateRouter, notificationsRouter, sitemapRouter — all
// student-facing/public-site/Flatmate/superadmin routes that belong on
// hostelnode.com, not this owner-only deployment. messagesRouter below
// is this repo's own SLIM, PG-chat-only variant (see that file's own
// header) — not the main repo's shared Flatmate+PG one.
const messagesRouter    = require("./routes/messagesRoutes");
const ownerMessagesRouter = require("./routes/ownerMessagesRoutes"); // Phase 4 — owner-side PG/Hostel inbox + chat pages, mounted at /user
const waBot             = require("./app-wa-bot");

// ════════════════════════════════════════════════════════════
//   CORE MIDDLEWARE  —  ORDER MATTERS
// ════════════════════════════════════════════════════════════

app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:5000",
  credentials: true
}));

app.use(cookieParser());                          // 1. cookies parse
// Subscriptions Phase 3: Razorpay's webhook must be read as raw bytes (its
// signature is checked against them), so it is parsed here, before JSON.
app.use("/payments/razorpay/webhook", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json());                          // 2. JSON body
app.use(express.urlencoded({ extended: true }));  // 3. form body
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride("_method"));               // 4. PUT/DELETE via POST
app.use(session({
  secret: process.env.SESSION_SECRET || "hostelnode_secret",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === "production" }
}));

// ── Global student attach — EJS mein student hamesha available ──
app.use(async (req, res, next) => {
  res.locals.student = null;
  const token = req.cookies?.studentToken;
  if (!token) return next();
  try {
    const decoded  = jwt.verify(token, process.env.JWT_SECRET);
    const student  = await Student.findById(decoded.id).lean();
    res.locals.student = student || null;
  } catch {
    res.clearCookie("studentToken");
  }
  next();
});

// ════════════════════════════════════════════════════════════
//   STATIC FILES
// ════════════════════════════════════════════════════════════
const UPLOAD_BASE = "/secure_uploads";
app.use("/student-images", express.static(path.join(UPLOAD_BASE, "students")));
app.use("/profile-image",  express.static(path.join(UPLOAD_BASE, "profiles")));
app.use("/listing-images", express.static(path.join(UPLOAD_BASE, "listings")));
app.use("/flatmate-images", express.static(path.join(UPLOAD_BASE, "flatmate")));
app.use(express.static(path.join(__dirname, "public")));

// ════════════════════════════════════════════════════════════
//   VIEW ENGINE
// ════════════════════════════════════════════════════════════
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.engine("ejs", ejsMate);

// ════════════════════════════════════════════════════════════
//   ROUTES  —  ORDER MATTERS
// ════════════════════════════════════════════════════════════
// Phase 1 — counts for the new navbar (messages / enquiries badges,
// setup chip). Read-only; never blocks or redirects a request.
app.use(require("./Middlewares/navData"));
app.use(require("./Middlewares/startTrial"));   // Subscriptions Phase 2: starts the free trial (once per login session)
app.use(require("./Middlewares/welcome"));      // Welcome popup once, right after signup (shows the plan the owner is on)
app.use(require("./Middlewares/planBanner"));   // Subscriptions Phase 4: "plan ends soon" notice (only when reminders are on)
app.use(require("./Middlewares/planGate"));     // Subscriptions Phase 4: plan limits (only when switched on in admin)
app.use(require("./Middlewares/planPopup"));    // Subscriptions: upgrade popup, limit notice and saved drafts (only on the pages that need them)

app.use("/webhook",     waBot);
app.use("/user",        require("./routes/roomsRoutes")); // Property Operations Phase 2 — rooms, beds, floors, listing link
app.use("/user",        require("./routes/tenantsRoutes")); // Property Operations Phase 3 — tenants, admission, move-out
app.use("/user",        require("./routes/kycOwnerRoutes")); // Property Operations Phase 4 — DigiLocker KYC (status, ask, verify on this phone)
app.use("/user",        userRouter);
app.use("/user",        ownerMessagesRouter); // Phase 4 — /user/messages, /user/messages/:conversationId
app.use("/user",        require("./routes/leadsRoutes")); // Phase 3 (redesign) — /user/leads, /user/enquiries/:id/status
app.use("/user",        require("./routes/accountRoutes")); // Phase 4 (redesign) — /user/account/*, /user/notifications
app.use("/user",        require("./routes/planRoutes"));    // Subscriptions Phase 2 — /user/account/plans
app.use("/user",        require("./routes/checkoutRoutes"));   // Subscriptions Phase 3 — pay page, verify, receipt
app.use("/user",        require("./routes/planDraftRoutes"));  // Subscriptions — discard a draft, publish a hidden-draft listing
app.use("/payments/razorpay", require("./routes/checkoutRoutes").webhook);   // Subscriptions Phase 3 — POST /payments/razorpay/webhook
// Phase 4 (redesign) — the previous navbar linked here; send those to the real pages.
app.get("/account/settings", (req, res) => res.redirect("/user/account/settings"));
app.get("/billing",          (req, res) => res.redirect("/user/account/billing"));
app.use("/messages",    messagesRouter);      // this repo's SLIM, PG-chat-only variant

// ── Root — this deployment has no public homepage (that's
//   hostelnode.com's job), so send a bare visit straight to login. ──
app.get("/", (req, res) => res.redirect("/login"));

// ── Auth pages — the Owner's own login/signup (userRoutes.js handles
//   the POST /user/signup submit; these just render the forms) ──
app.get("/signup",       (req, res) => res.render("authPrivate/signup.ejs"));
app.get("/login",        (req, res) => res.render("authPrivate/login.ejs"));

// ── Privacy & Terms ──────────────────────────────────────────
app.get("/privacy-policy", (req, res) => {
  res.send(`<h1>Privacy Policy - HostelNode</h1><p>Last updated: May 2026</p><p>Email: support@hostelnode.com</p>`);
});
app.get("/terms", (req, res) => {
  res.send(`<h1>Terms of Service - HostelNode</h1><p>Last updated: May 2026</p><p>Email: support@hostelnode.com</p>`);
});

// ════════════════════════════════════════════════════════════
//   CRON — Monthly Fee Check (midnight daily)
// ════════════════════════════════════════════════════════════
// Subscriptions Phase 4 — plan expiry reminder emails, every day at 10:00 am India time.
// Does nothing unless "Remind owners before a plan ends" is on in admin.
cron.schedule("0 10 * * *", async () => {
  try {
    const r = await require("./utils/planReminders").runReminders();
    if (r.sent) console.log(`Plan reminders: ${r.sent} sent`);
  } catch (err) {
    console.error("Plan reminders (non-fatal):", err.message);
  }
}, { timezone: "Asia/Kolkata" });

// Property Operations Phase 1 — monthly rent charges (utils/monthlyRent.js): India time,
// once per tenant per month however often it runs, and catches up after downtime.
// Runs at 00:05 every night and once a minute after the server starts.
cron.schedule("5 0 * * *", async () => {
  const r = await require("./utils/monthlyRent").runMonthlyRent();
  if (r.charged || r.errors) console.log(`Monthly rent: ${r.charged} charged, ${r.errors} errors`);
}, { timezone: "Asia/Kolkata" });
setTimeout(() => {
  require("./utils/monthlyRent").runMonthlyRent()
    .then(r => { if (r.charged || r.errors) console.log(`Monthly rent (startup check): ${r.charged} charged, ${r.errors} errors`); })
    .catch(() => {});
}, Number(process.env.HN_RENT_STARTUP_DELAY_MS) || 60 * 1000).unref();

// (Flatmate reminder cron removed — Flatmate doesn't run on this
//   deployment at all, so there's nothing for it to sweep here.)

// ════════════════════════════════════════════════════════════
//   START SERVER
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 6060;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});