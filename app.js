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
const sitemap      = require("express-sitemap-xml");

// ── DB ──────────────────────────────────────────────────────
const connectDB = require("./config/db");
connectDB();

// ── Models ──────────────────────────────────────────────────
const Student  = require("./models/studentSchema");
const Floor    = require("./models/floor.js");
const Room     = require("./models/room.js");
const Member   = require("./models/member.js");
const Payment  = require("./models/payment.js");
const User     = require("./models/user.js");
// const Admin    = require("./models/admin.js");

// ── Middlewares ──────────────────────────────────────────────
// const { visitorTracker, trackGpsLocation } = require("./Middlewares/visitorTracker");

// ── Routes ───────────────────────────────────────────────────
// const publicRoutes      = require("./routes/public.js");
// const findHostelsRouter = require("./routes/findHostels-route");
// const studentRouter     = require("./routes/studentRoutes");
// const adminRouter       = require("./routes/adminRoutes");
// const cityRouter        = require("./routes/cityRoutes");
// const sitemapRouter     = require("./routes/sitemapRoute");
const waBot             = require("./app-wa-bot");

// ════════════════════════════════════════════════════════════
//   CORE MIDDLEWARE  —  ORDER MATTERS
// ════════════════════════════════════════════════════════════

app.use(cors({
  origin: process.env.CLIENT_URL ,
  credentials: true
}));

app.use(cookieParser());                          // 1. cookies parse
app.use(express.json());                          // 2. JSON body
app.use(express.urlencoded({ extended: true }));  // 3. form body
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride("_method"));               // 4. PUT/DELETE via POST
// With other app.use() route mounts (after session middleware)
app.use("/user", userRouter);
app.use(session({
  secret: process.env.SESSION_SECRET || "hostelnode_secret",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === "production" }
}));
app.get("/", (req, res) => {
  res.redirect("/user");
});
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

// ── Visitor tracker ─────────────────────────────────────────
// app.use(visitorTracker);

// ════════════════════════════════════════════════════════════
//   STATIC FILES
// ════════════════════════════════════════════════════════════
const UPLOAD_BASE = "/secure_uploads";
app.use("/student-images", express.static(path.join(UPLOAD_BASE, "students")));
app.use("/profile-image",  express.static(path.join(UPLOAD_BASE, "profiles")));
app.use("/listing-images", express.static(path.join(UPLOAD_BASE, "listings")));
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
// app.post("/track-location", trackGpsLocation);

app.use("/webhook",     waBot);
// app.use("/admin",       adminRouter);
// app.use("/student",     studentRouter);
// app.use("/findHostels", findHostelsRouter);
// app.use("/city",        cityRouter);
// app.use("/",            sitemapRouter);
// app.use("/",            publicRoutes);

// ── Auth pages ──────────────────────────────────────────────
app.get("/signup",       (req, res) => res.render("authPrivate/signup.ejs"));
app.get("/login",        (req, res) => res.render("authPrivate/login.ejs"));
// app.get("/loginforadmin",(req, res) => res.render("authPrivate/login-admin.ejs"));

// ── Admin login ─────────────────────────────────────────────
app.post("/admin-login", async (req, res) => {
  try {
    const { username, password } = req.body.admin;
    const admin = await Admin.findOne({ username });

    if (!admin) {
      return res.render("authPrivate/login-admin.ejs", { error: "Invalid username or password" });
    }
    if (admin.status !== "Active") {
      return res.render("authPrivate/login-admin.ejs", { error: "Account inactive. Contact support." });
    }
    if (password !== admin.password) {
      return res.render("authPrivate/login-admin.ejs", { error: "Invalid Password" });
    }

    const users   = await User.find();
    const isadmin = await Admin.findOne({ username });
    res.render("superAdmin/admin", { users, isadmin });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Toggle user status ───────────────────────────────────────
app.put("/dashboard/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const newStatus = user.status === "Active" ? "Inactive" : "Active";
    await User.findByIdAndUpdate(req.params.id, { status: newStatus });
    res.send("STATUS UPDATED");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating user status");
  }
});

// ── Privacy & Terms ──────────────────────────────────────────
app.get("/privacy-policy", (req, res) => {
  res.send(`<h1>Privacy Policy - HostelNode</h1><p>Last updated: May 2026</p><p>Email: support@hostelnode.com</p>`);
});
app.get("/terms", (req, res) => {
  res.send(`<h1>Terms of Service - HostelNode</h1><p>Last updated: May 2026</p><p>Email: support@hostelnode.com</p>`);
});

// ── Sitemap ──────────────────────────────────────────────────
app.use(sitemap(
  async () => ["https://hostelnode.com/", "https://hostelnode.com/findHostels"],
  "https://hostelnode.com"
));

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
 
// ════════════════════════════════════════════════════════════
//   START SERVER
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT ;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});