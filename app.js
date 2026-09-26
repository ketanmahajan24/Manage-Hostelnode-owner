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
app.use("/webhook",     waBot);
app.use("/user",        userRouter);
app.use("/user",        ownerMessagesRouter); // Phase 4 — /user/messages, /user/messages/:conversationId
app.use("/messages",    messagesRouter);      // this repo's SLIM, PG-chat-only variant

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
cron.schedule("0 0 * * *", async () => {
  console.log("🔄 Running Monthly Fee Check...");
  try {
    const today   = moment().startOf("day");
    const members = await Member.find({ status: "Active" });

    for (let member of members) {
      const joiningDate = moment(member.joiningDate).startOf("day");
      if (joiningDate.date() === today.date()) {
        const room = await Room.findById(member.assignedRoom_id);
        if (!room) continue;

        const newPayment = new Payment({
          memberId:     member._id,
          roomId:       room._id,
          roomFees:     room.room_fees,
          totalFees:    room.room_fees,
          advancedPaid: 0,
          amountPaid:   0,
          dueAmount:    room.room_fees,
          status:       "Due",
          paymentDate:  new Date()
        });

        await newPayment.save();
        member.payments.push(newPayment._id);
        await member.save();
        console.log(`💰 Fee added for ${member.name}`);
      }
    }
  } catch (err) {
    console.error("❌ Cron error:", err);
  }
});

// (Flatmate reminder cron removed — Flatmate doesn't run on this
//   deployment at all, so there's nothing for it to sweep here.)

// ════════════════════════════════════════════════════════════
//   START SERVER
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 6060;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});