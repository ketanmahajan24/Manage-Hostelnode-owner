const express = require('express');
const router = express.Router();
 
const session = require("express-session");
const otpGenerator = require("otp-generator");
const Otp = require("../models/Otp");
const { sendWhatsAppOTP } = require("../models/Whatsapp.js");
const multer = require("multer");
const path = require("path");
const Listing = require("../models/listingProperty");
const Owner = require("../models/owner");
const { jwtAuthMiddleware, generateToken } = require('./../jwt.js');
const otpStore = new Map();
const Enquiry = require("../models/enquiry");
const Floor = require("../models/floor.js");
const Room = require("../models/room.js");
const Member = require("../models/member.js");
const Payment = require("../models/payment.js");
const Hostel = require("../models/hostel.js");
const { buildDashboard } = require("../utils/dashboardData.js"); // Phase 2
const { loadOwnedEnquiry, closeEnquiryAfterConvert, indianMobile } = require("../utils/leads.js"); // Phase 3
const crypto = require('crypto');
const fs = require('fs');
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const validator = require("validator");
const nodemailer = require("nodemailer");

// ============================================================
//  SEND MAIL (defined once at top, used everywhere below)
// ============================================================
const sendMail = async (to, subject, html) => {
  try {
    if (!to || !subject || !html) return; // guard against bad calls
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.MAIL_USER || "hostelnodehelp@gmail.com",
        pass: process.env.MAIL_PASS || "sxiwxzxbdujxiyra"
      }
    });
    await transporter.sendMail({
      from: `"HostelNode" <${process.env.MAIL_USER || "hostelnodehelp@gmail.com"}>`,
      to,
      subject,
      html
    });
  } catch (error) {
    console.error("❌ Email Error (non-fatal):", error.message);
    // Never re-throw — email failure must never crash a route
  }
};

// ============================================================
//  HELPERS
// ============================================================

/** Send a clean JSON error — never leaks stack traces */
function userError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

/** Safely render a page — falls back to plain text on render failure */
function safeRender(res, view, data = {}) {
  try {
    return res.render(view, data);
  } catch (renderErr) {
    console.error(`❌ Render error (${view}):`, renderErr.message);
    return res.status(500).send("Page could not be loaded. Please try again.");
  }
}

/** Clean string: trim + strip HTML tags + cap length */
function clean(str, max = 2000) {
  if (typeof str !== "string") return "";
  return str.trim().replace(/<[^>]*>/g, "").slice(0, max);
}

/** Safe positive number with fallback */
function toNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Ensure upload dir exists — never crashes the process */
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error("❌ Could not create upload dir:", e.message);
  }
}

// ============================================================
//  UPLOAD DIRECTORIES
// ============================================================
const uploadDir       = '/secure_uploads/profiles';
const listingUploadDir = '/secure_uploads/listings';
ensureDir(uploadDir);
ensureDir(listingUploadDir);

// ============================================================
//  FILE FILTER (shared)
// ============================================================
const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error('Only JPG, PNG, WEBP images are allowed.');
    err.isFileTypeError = true;
    cb(err, false);
  }
};

// ============================================================
//  MULTER — PROFILE IMAGES
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const name = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, name);
  }
});
const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// ============================================================
//  MULTER — LISTING IMAGES
// ============================================================
const listingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(listingUploadDir);
    cb(null, listingUploadDir);
  },
  filename: (req, file, cb) => {
    const name = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, name);
  }
});
const listingUpload = multer({
  storage: listingStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }  // 5 MB per image
});

// ============================================================
//  MULTER ERROR WRAPPER (for profile upload routes)
// ============================================================
const handleMulterError = (fn) => (req, res, next) => {
  fn(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE")
        return userError(res, 413, "File too large. Max 10 MB per image.");
      if (err.code === "LIMIT_FILE_COUNT")
        return userError(res, 413, "Too many files. Max 15 images.");
      return userError(res, 400, `Upload error: ${err.message}`);
    }
    if (err?.isFileTypeError) return userError(res, 400, err.message);
    console.error("❌ Unknown upload error:", err?.message);
    return userError(res, 500, "Upload failed. Please try again.");
  });
};

// ============================================================
//  ATTACH HOSTEL MIDDLEWARE
// ============================================================
const attachHostel = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return next();

    const hostels = await Hostel.find({ owner: userId });
    let selectedHostel = null;

    if (req.session?.selectedHostel) {
      // Phase 1 — only ever select one of this owner's own properties.
      selectedHostel = await Hostel.findOne({ _id: req.session.selectedHostel, owner: userId }).catch(() => null);
    }
    if (!selectedHostel && hostels.length > 0) selectedHostel = hostels[0];

    res.locals.hostels = hostels;
    res.locals.selectedHostel = selectedHostel;
    next();
  } catch (err) {
    console.error("attachHostel error (non-fatal):", err.message);
    next(); // never block the request
  }
};

// ============================================================
//  OTP — SEND  (used by signup page)
// ============================================================
router.post("/send-otp", async (req, res) => {
  try {
    const phone = clean(req.body.phone || "");

    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.json({ success: false, error: "Invalid phone number. Enter a valid 10-digit Indian number." });
    }

    // Check duplicate BEFORE sending OTP
    const existing = await Owner.findOne({ phone });
    if (existing) {
      return res.json({ success: false, error: "This phone number is already registered." });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(phone, { otp, verified: false, expiresAt: Date.now() + 5 * 60 * 1000 });

    const result = await sendWhatsAppOTP(phone, otp);
    if (result && result.success === false) {
      return res.json({ success: false, error: result.error || "Failed to send OTP. Try again." });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("OTP send error:", err.message);
    res.json({ success: false, error: "Failed to send OTP. Please try again." });
  }
});

// ============================================================
//  OTP — VERIFY
// ============================================================
router.post("/verify-otp", (req, res) => {
  try {
    const phone = clean(req.body.phone || "");
    const otp   = clean(req.body.otp   || "");

    if (!phone || !otp) {
      return res.json({ success: false, error: "Phone and OTP are required." });
    }

    const stored = otpStore.get(phone);
    if (!stored) return res.json({ success: false, error: "OTP not sent or expired. Please request a new one." });

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(phone);
      return res.json({ success: false, error: "OTP expired. Please request a new one." });
    }
    if (stored.otp !== otp) return res.json({ success: false, error: "Incorrect OTP. Please try again." });

    otpStore.set(phone, { ...stored, verified: true });
    res.json({ success: true });
  } catch (err) {
    console.error("OTP verify error:", err.message);
    res.json({ success: false, error: "Server error. Please try again." });
  }
});

// ============================================================
//  SIGNUP
// ============================================================
router.post("/signup", handleMulterError(upload.single("profileImage")), async (req, res) => {
  try {
    const name     = clean(req.body.name     || "");
    const email    = clean(req.body.email    || "").toLowerCase();
    const phone    = clean(req.body.phone    || "");
    const password = req.body.password || "";

    // ── Validation ──
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }
    if (name.length < 3) {
      return res.status(400).json({ error: "Name must be at least 3 characters." });
    }
    if (!validator.isEmail(email)) {
      return res.status(400).json({ error: "Invalid email format." });
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: "Invalid phone number. Enter a valid 10-digit Indian number." });
    }
    if (!validator.isStrongPassword(password, { minLength: 6, minNumbers: 1 })) {
      return res.status(400).json({ error: "Password must be at least 6 characters and include at least 1 number." });
    }

    // ── OTP check ──
    const otpData = otpStore.get(phone);
    if (!otpData) {
      return res.status(400).json({ error: "OTP not sent or expired. Please request a new OTP." });
    }
    if (Date.now() > otpData.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }
    if (!otpData.verified) {
      return res.status(400).json({ error: "Phone not verified. Please enter the OTP first." });
    }
    otpStore.delete(phone);

    // ── Duplicate check ──
    const existingEmail = await Owner.findOne({ email });
    if (existingEmail) return res.status(400).json({ error: "This email is already registered." });

    const existingPhone = await Owner.findOne({ phone });
    if (existingPhone) return res.status(400).json({ error: "This phone number is already registered." });

    // ── Create owner ──
    const hashedPassword = await bcrypt.hash(password, 10);
    const newOwner = new Owner({
      name,
      email,
      phone,
      password:        hashedPassword,
      profileImage:    req.file ? req.file.filename : null,
      hostels:         [],
      listings:        [],
      status:          "Active",
      isPhoneVerified: true,
      role:            "Owner"
    });
    await newOwner.save();

    // ── Welcome email (non-blocking) ──
    sendMail(
      newOwner.email,
      "🎉 Welcome to HostelNode!",
      `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#09B850;">Welcome to HostelNode 🚀</h2>
        <p>Hi ${newOwner.name},</p>
        <p>🎉 Your account has been successfully created!</p>
        <p>HostelNode helps you manage your hostel easily — rooms, members, payments, everything in one place.</p>
      </div>`
    );

    // ── Admin notification (non-blocking) ──
    sendMail(
      "ketanmahajan2424@gmail.com",
      "🚀 New Owner Signup - HostelNode",
      `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#09B850;">🎉 New Owner Registered</h2>
        <p><b>Name:</b> ${newOwner.name}</p>
        <p><b>Email:</b> ${newOwner.email}</p>
        <p><b>Phone:</b> ${newOwner.phone}</p>
        <p><b>Time:</b> ${new Date().toLocaleString("en-IN")}</p>
      </div>`
    );

    // Log the new owner straight in (same cookie as the login form sets) and take
    // them to their dashboard, where a welcome popup shows the plan they are on.
    // If anything here fails they see the old "account created" page and log in as before.
    try {
      const token = generateToken({ id: newOwner._id, email: newOwner.email, role: newOwner.role });
      res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
      if (req.session) req.session.hnWelcome = String(newOwner._id);
      // The signup form submits in the background and then opens the address we send back,
      // so the dashboard (and its welcome popup) is loaded once, by the browser itself.
      if (/text\/html/.test(req.get("accept") || "")) return res.redirect(303, '/user');
      return res.status(201).json({ ok: true, redirect: '/user' });
    } catch (loginErr) {
      console.error("Signup auto-login (non-fatal):", loginErr.message);
    }

    return safeRender(res.status(201), "authPrivate/signupSuccess.ejs", {
      message: "Signup successful",
      user: { name: newOwner.name, email: newOwner.email, status: newOwner.status }
    });

  } catch (err) {
    console.error("SIGNUP ERROR:", err.message);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || "field";
      return res.status(400).json({ error: `${field === "email" ? "Email" : "Phone"} already registered.` });
    }
    res.status(500).json({ error: "Server error. Please try again later." });
  }
});

// ============================================================
//  LOGIN
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const userBody = req.body.user;
    if (!userBody) {
      return safeRender(res, "authPrivate/login.ejs", { error: "Invalid request. Please try again." });
    }

    const email    = clean(userBody.email    || "").toLowerCase();
    const password = userBody.password || "";
    const role     = clean(userBody.role     || "");

    if (!email || !password || !role) {
      return safeRender(res, "authPrivate/login.ejs", { error: "Please enter email, password, and role." });
    }

    const user = await Owner.findOne({
      email,
      role,
      status: { $in: ["Pending", "Active", "Inactive"] }
    });

    if (!user) {
      return safeRender(res, "authPrivate/login.ejs", { error: "Invalid credentials or account not found." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return safeRender(res, "authPrivate/login.ejs", { error: "Invalid credentials." });
    }

    const token = generateToken({ id: user._id, email: user.email, role: user.role });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });

    // Login alert email (non-blocking). Phase 4 (redesign): owners can turn
    // this off in Settings; missing field = on, as before.
    if (user.loginAlerts !== false) sendMail(
      user.email,
      "🔐 New Login Detected - HostelNode",
      `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#09B850;">New Login Alert 🔐</h2>
        <p>Hello ${user.name},</p>
        <p>Your HostelNode account was just accessed.</p>
        <ul>
          <li><b>Time:</b> ${new Date().toLocaleString()}</li>
          <li><b>IP:</b> ${req.ip || "Unknown"}</li>
        </ul>
        <p style="color:red;"><b>⚠️ If this was NOT you, please reset your password immediately.</b></p>
      </div>`
    );

    res.redirect('/user');

  } catch (err) {
    console.error("Login Error:", err.message);
    safeRender(res.status(500), "authPrivate/login.ejs", { error: "Server error. Please try again later." });
  }
});

// ============================================================
//  DASHBOARD
// ============================================================
router.get('/', jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId = req.user.id;
    const user   = await Owner.findById(userId);

    if (!user) return res.redirect('/login');

    const hostels = await Hostel.find({ owner: userId });

    if (!hostels || hostels.length === 0) {
      return safeRender(res, "onboarding.ejs", { user });
    }

    // Phase 2 — global dashboard across all properties (approved design).
    // HN_NEW_UI=0 — or an error while gathering its data — falls through
    // to the previous per-property dashboard below, which is unchanged.
    if (process.env.HN_NEW_UI !== "0") {
      let dash = null;
      try {
        dash = await buildDashboard(userId, hostels);
      } catch (dashErr) {
        console.error("Global dashboard error (showing previous dashboard):", dashErr.message);
      }
      if (dash) {
        return safeRender(res, "dashboard-v2.ejs", {
          user, hostels, selectedHostel: res.locals.selectedHostel, dash
        });
      }
    }

    const selectedHostelId = res.locals.selectedHostel?._id || hostels[0]._id;

    const [rooms, floors, members] = await Promise.all([
      Room.find({ user: userId, hostel: selectedHostelId }),
      Floor.find({ user: userId, hostel: selectedHostelId }),
      Member.find({ user: userId, hostel: selectedHostelId }).populate("payments")
    ]);

    const totalBeds     = rooms.reduce((s, r) => s + (r.sharing_capacity || 0), 0);
    const occupiedBeds  = rooms.reduce((s, r) => s + (r.occupied_beds    || 0), 0);
    const availableBeds = totalBeds - occupiedBeds;
    const bookedRooms   = rooms.filter(r => r.occupied_beds > 0).length;

    let totalExpectedRevenue = 0, totalFeesCollected = 0,
        totalPendingAmount   = 0, totalAdvancedPaid   = 0,
        paidAccounts         = 0, dueAccounts         = 0;

    // Property Operations Phase 1: removed tenants count only for what they paid.
    withMoney(members).forEach(m => {
      totalExpectedRevenue += m.totalFees;
      totalFeesCollected   += m.amountPaid;
      totalPendingAmount   += m.dueAmount;
      totalAdvancedPaid    += m.advancedPaid;
      if (m.removedAt) return;
      m.dueAmount > 0 ? dueAccounts++ : paidAccounts++;
    });

    const fmt = n => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
    const feesCollectionCompleted = totalExpectedRevenue > 0
      ? ((totalFeesCollected / totalExpectedRevenue) * 100).toFixed(2)
      : 0;

    safeRender(res, 'dashboard.ejs', {
      user, hostels,
      selectedHostel:         res.locals.selectedHostel,
      availableBeds, totalBeds, bookedRooms,
      totalRooms:              rooms.length,
      totalStudents:           members.filter(m => !m.leftDate && !m.removedAt).length,
      totalPendingAmount:      fmt(totalPendingAmount),
      totalAdvancedPaid:       fmt(totalAdvancedPaid),
      totalFeesCollected:      fmt(totalFeesCollected),
      totalExpectedRevenue:    fmt(totalExpectedRevenue),
      balance:                 fmt(totalExpectedRevenue - totalFeesCollected),
      feesCollectionCompleted, paidAccounts, dueAccounts
    });

  } catch (err) {
    console.error("Dashboard error:", err.message);
    res.status(500).send("Server Error. Please refresh the page.");
  }
});

// ============================================================
//  EDIT OWNER PROFILE (GET)
// ============================================================
router.get("/editOwner", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    if (!user) return res.redirect('/login');
    safeRender(res, "showPage/owner/editOwner.ejs", { user });
  } catch (err) {
    console.error("editOwner GET error:", err.message);
    res.status(500).send("Error loading page. Please try again.");
  }
});

// ============================================================
//  EDIT OWNER PROFILE (POST)
// ============================================================
router.post("/editOwner", jwtAuthMiddleware, handleMulterError(upload.single("profileImage")), async (req, res) => {
  try {
    const userId = req.user.id;

    const updateData = {
      name:         clean(req.body.name         || ""),
      phone:        clean(req.body.phone        || ""),
      whatsapp:     clean(req.body.whatsapp     || ""),
      businessName: clean(req.body.businessName || ""),
      businessType: clean(req.body.businessType || ""),
      city:         clean(req.body.city         || ""),
      state:        clean(req.body.state        || ""),
      country:      clean(req.body.country      || ""),
      pincode:      clean(req.body.pincode      || ""),
    };

    if (updateData.name.length < 2) {
      return res.status(400).send("Name must be at least 2 characters.");
    }
    if (updateData.phone && !/^[6-9]\d{9}$/.test(updateData.phone)) {
      return res.status(400).send("Invalid phone number.");
    }

    if (updateData.city && updateData.state && updateData.country) {
      updateData.location = `${updateData.city}, ${updateData.state}, ${updateData.country}`;
    }

    if (req.file) updateData.profileImage = req.file.filename;

    await Owner.findByIdAndUpdate(userId, updateData);
    res.redirect("/user");

  } catch (err) {
    console.error("editOwner POST error:", err.message);
    res.status(500).send("Update failed. Please try again.");
  }
});

// ============================================================
//  SELECT HOSTEL
// ============================================================
// Phase 1 — after switching, return the owner to the section they were
// on (?next=...) instead of always the dashboard. `next` is only
// honoured if it matches a known owner list page, so it can't be used
// as an open redirect or land on a record from the previous property.
const SWITCH_RETURN_EXACT = new Set([
  "/user", "/user/members", "/user/activeMember", "/user/newmember",
  "/user/allfeesrecords", "/user/upcomingPayments", "/user/deureports", "/user/revenue",
  "/user/allrooms", "/user/managerooms", "/user/newroom",
  "/user/floors", "/user/managefloor", "/user/newfloor",
  "/user/my-listings", "/user/list-property", "/user/messages",
  "/user/editOwner", "/user/addnewhostel",
]);
const SWITCH_RETURN_SECTION = [
  [/^\/user\/(member-edit\/|member\/|activeMember\/|newAdded|tenants\/)/, "/user/members"],
  [/^\/user\/(members\/[^/]+\/addpayment|addpayment\/|payment-receipt\/|payment-history\/|searchfeesrecords)/, "/user/allfeesrecords"],
  [/^\/user\/(managerooms\/|manageroom\/)/, "/user/managerooms"],
  [/^\/user\/listing\//, "/user/my-listings"],
  [/^\/user\/messages\//, "/user/messages"],
];
function switchReturnPath(next) {
  if (typeof next !== "string") return "/user";
  const p = next.split("?")[0].split("#")[0];
  // Phase 3 — keep an in-progress "Convert enquiry to tenant" across a switch.
  const conv = next.match(/^\/user\/newmember\?enquiry=([a-f0-9]{24})$/i);
  if (conv) return `/user/newmember?enquiry=${conv[1]}`;
  // Property Operations Phase 3 — open a tenant's page after switching to their property (the page checks ownership).
  const tenant = next.match(/^\/user\/tenants\/([a-f0-9]{24})$/i);
  if (tenant) return `/user/tenants/${tenant[1]}`;
  // Phase 3 — keep Leads & CRM filters (Leads is global; filters are harmless).
  if (p === "/user/leads") return /^\/user\/leads(\?[\w=&%.+-]*)?$/.test(next) ? next : "/user/leads";
  if (SWITCH_RETURN_EXACT.has(p)) return p;
  for (const [re, target] of SWITCH_RETURN_SECTION) if (re.test(p)) return target;
  return "/user";
}

router.get("/hostel/:id", jwtAuthMiddleware, async (req, res) => {
  try {
    const hostelId = clean(req.params.id || "");
    if (!hostelId) return res.redirect("/user");
    // Only select a property that belongs to this owner.
    const owned = await Hostel.exists({ _id: hostelId, owner: req.user.id });
    if (!owned) return res.redirect("/user");
    req.session.selectedHostel = hostelId;
    res.redirect(switchReturnPath(req.query.next));
  } catch (err) {
    console.error("Hostel select error:", err.message);
    res.redirect("/user");
  }
});

// ============================================================
//  ADD NEW HOSTEL (GET)
// ============================================================
router.get("/addnewhostel", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId  = req.user.id;
    const user    = await Owner.findById(userId);
    const hostels = await Hostel.find({ owner: userId });
    safeRender(res, "showPage/hostels/addnewhostel.ejs", { user, hostels });
  } catch (err) {
    console.error("addnewhostel GET error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

// ============================================================
//  CREATE HOSTEL (POST)
// ============================================================
router.post("/create-hostel", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId = req.user.id;
    const hostelName = clean(req.body.hostelName || "");
    const city       = clean(req.body.city       || "");
    const state      = clean(req.body.state      || "");
    const country    = clean(req.body.country    || "");
    const pincode    = clean(req.body.pincode    || "");

    if (!hostelName || !city || !state || !country || !pincode) {
      return res.status(400).send("All fields are required.");
    }
    if (hostelName.length < 3) {
      return res.status(400).send("Hostel name must be at least 3 characters.");
    }
    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).send("Pincode must be exactly 6 digits.");
    }

    const prefix = city.substring(0, 3).toUpperCase();
    const count  = await Hostel.countDocuments({ hostelId: { $regex: `^${prefix}` } });
    const newHostelId = prefix + String(count + 1).padStart(4, "0");

    const newHostel = new Hostel({
      hostelName,
      city, state, country, pincode,
      location:  `${city}, ${state}, ${country}`,
      hostelId:  newHostelId,
      owner:     userId,
      createdAt: new Date()
    });
    await newHostel.save();

    await Owner.findByIdAndUpdate(userId, { $push: { hostelIds: newHostelId } });
    res.redirect("/user");

  } catch (err) {
    console.error("create-hostel error:", err.message);
    if (err.code === 11000) return res.status(400).send("A hostel with this ID already exists. Please try again.");
    res.status(500).send("Server Error. Please try again.");
  }
});

// ============================================================
//  PROPERTY OPERATIONS — Phase 1 safety fixes (tenants, rooms, floors, payments)
//
//  • Every record is looked up together with the logged-in owner, so one
//    owner can never open or change another owner's tenants, rooms,
//    floors or payments by guessing an id.
//  • Bed counts are re-counted from the real tenants after each change
//    (utils/tenantOps.js), so they cannot drift or go negative.
//  • "Living here" = not moved out and not removed. Removing a tenant
//    keeps the record and its payments, so reports stay correct.
// ============================================================
const { LIVING, NOT_REMOVED, isId, escapeRegex, syncRoomAndFloor, syncFloor, money, nextDueDate, dueAnchor, TZ } = require("../utils/tenantOps");

// Money owed / collected for a list of tenants (removed tenants: what they paid still counts as collected; their unpaid rent does not).
function withMoney(members) {
  return members.map(m => {
    const f = money(m);
    const obj = typeof m.toObject === "function" ? m.toObject() : m;
    if (m.removedAt) return { ...obj, totalFees: f.paid, amountPaid: f.paid, dueAmount: 0, advancedPaid: 0 };
    return { ...obj, totalFees: f.fees, amountPaid: f.paid, dueAmount: f.due, advancedPaid: f.advance };
  });
}

// "Please select a property" for pages that need one.
const needProperty = res => res.status(400).send("⚠️ Please select a hostel first.");

// A positive amount of money, or null if what was typed is not one.
function moneyIn(v, { max = 10000000 } = {}) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
}

// ============================================================
//  FLOORS
// ============================================================
router.get("/floors", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    const allFloors      = selectedHostel
      ? await Floor.find({ user: userId, hostel: selectedHostel })
      : [];
    safeRender(res, "showPage/floors/floor.ejs", { allFloors, user });
  } catch (err) {
    console.error("floors error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/managefloor", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    const allFloors      = selectedHostel
      ? await Floor.find({ user: userId, hostel: selectedHostel })
      : [];
    safeRender(res, "showPage/floors/managefloor.ejs", { allFloors, user });
  } catch (err) {
    console.error("managefloor error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/newfloor", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    safeRender(res, "showPage/floors/newFloor.ejs", { user });
  } catch (err) {
    console.error("newfloor GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.post("/newfloor", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const floorBody      = req.body.floor || {};
    const floor_name     = clean(floorBody.floor_name || "", 40);
    const userId         = req.user.id;
    const selectedHostel = res.locals.selectedHostel?._id;   // only ever one of this owner's own properties

    if (!floor_name) return res.status(400).send("Floor name is required.");
    if (!selectedHostel) return needProperty(res);

    const existing = await Floor.findOne({ floor_name: { $regex: `^${escapeRegex(floor_name)}$`, $options: "i" }, user: userId, hostel: selectedHostel });
    if (existing) return res.status(400).send(`Floor "${floor_name}" already exists in this hostel.`);

    const newFloor = new Floor({ floor_name, user: userId, hostel: selectedHostel });
    await newFloor.save();
    res.redirect("/user/floors");

  } catch (err) {
    console.error("newfloor POST error:", err.message);
    if (err.code === 11000) return res.status(400).send("Duplicate floor entry.");
    if (err.name === "ValidationError") return res.status(400).send("Validation Error: " + err.message);
    res.status(500).send("Server Error. Please try again.");
  }
});

router.delete("/managefloor/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const selectedHostel = res.locals.selectedHostel?._id;
    const { id }         = req.params;

    if (!isId(id) || !selectedHostel) return res.status(400).send("Invalid floor ID.");

    const floor = await Floor.findOne({ _id: id, user: userId, hostel: selectedHostel });
    if (!floor) return res.status(404).send("Floor not found.");
    // A floor that still has rooms cannot be deleted: its rooms (and the tenants in them) would be left without a floor.
    const rooms = await Room.countDocuments({ floor_id: floor._id });
    if (rooms) return res.status(400).send(`Floor "${floor.floor_name}" still has ${rooms} room${rooms === 1 ? "" : "s"}. Delete or move ${rooms === 1 ? "that room" : "those rooms"} first.`);

    await Floor.deleteOne({ _id: floor._id });
    res.redirect("/user/managefloor");
  } catch (err) {
    console.error("delete floor error:", err.message);
    res.status(500).send("Delete failed. Please try again.");
  }
});

// ============================================================
//  ROOMS
// ============================================================
router.get("/allrooms", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const [allRooms, allFloors] = await Promise.all([
      Room.find({ user: userId, hostel: selectedHostel }),
      Floor.find({ user: userId, hostel: selectedHostel })
    ]);
    safeRender(res, "showPage/rooms/allrooms.ejs", { allRooms, allFloors, user });
  } catch (err) {
    console.error("allrooms error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/managerooms", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const allRooms = await Room.find({ user: userId, hostel: selectedHostel });
    safeRender(res, "showPage/rooms/managerooms.ejs", { allRooms, user });
  } catch (err) {
    console.error("managerooms error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/newroom", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const floors = await Floor.find({ user: userId, hostel: selectedHostel });
    safeRender(res, "showPage/rooms/newRoom.ejs", { floors, user });
  } catch (err) {
    console.error("newroom GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.post("/newroom", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const roomBody       = req.body.room || {};
    const floor_id       = roomBody.floor_id;
    const room_number    = clean(roomBody.room_number || "", 20);
    const room_fees      = moneyIn(roomBody.room_fees);
    const sharing_cap    = Number(roomBody.sharing_capacity);

    if (!floor_id || !isId(String(floor_id)) || !room_number) {
      return res.status(400).send("Floor and room number are required.");
    }
    if (room_fees === null) return res.status(400).send("Enter the rent per bed as a number (0 or more).");
    if (!Number.isInteger(sharing_cap) || sharing_cap < 1 || sharing_cap > 50) return res.status(400).send("Sharing capacity must be a whole number from 1 to 50.");

    const floor = await Floor.findOne({ _id: floor_id, user: userId, hostel: selectedHostel });
    if (!floor) return res.status(404).send("Floor not found or you are not authorized.");

    const existing = await Room.findOne({ room_number: { $regex: `^${escapeRegex(room_number)}$`, $options: "i" }, floor_id, hostel: selectedHostel });
    if (existing) return res.status(400).send(`Room "${room_number}" already exists on this floor.`);

    // A new room is empty: its beds fill as tenants are added.
    const newRoom = new Room({
      user: userId, hostel: selectedHostel, floor_id,
      floor_name: floor.floor_name, room_number, room_fees,
      sharing_capacity: sharing_cap, occupied_beds: 0
    });
    await newRoom.save();
    await syncFloor(floor._id).catch(e => console.error("Floor count (non-fatal):", e.message));
    res.redirect("/user/allrooms");

  } catch (err) {
    console.error("newroom POST error:", err.message);
    if (err.code === 11000) return res.status(400).send("Duplicate room entry.");
    if (err.name === "ValidationError") return res.status(400).send("Validation Error: " + err.message);
    res.status(500).send("Server Error. Please try again.");
  }
});

router.get("/managerooms/:id/edit", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!isId(req.params.id)) return res.status(404).send("Room not found or you are not authorized.");

    const room = await Room.findOne({ _id: req.params.id, user: userId, hostel: selectedHostel });
    if (!room) return res.status(404).send("Room not found or you are not authorized.");

    safeRender(res, "showPage/rooms/Edit-Room.ejs", { room, user });
  } catch (err) {
    console.error("room edit GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.put("/manageroom/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId      = req.user.id;
    const { id }      = req.params;
    const roomBody    = req.body.room || {};
    const room_fees   = moneyIn(roomBody.room_fees);
    const sharing_cap = Number(roomBody.sharing_capacity);
    if (!isId(id)) return res.status(404).send("Room not found.");

    const room = await Room.findOne({ _id: id, user: userId });
    if (!room) return res.status(404).send("Room not found.");
    if (room_fees === null) return res.status(400).send("Enter the rent per bed as a number (0 or more).");
    if (!Number.isInteger(sharing_cap) || sharing_cap < 1 || sharing_cap > 50) return res.status(400).send("Sharing capacity must be a whole number from 1 to 50.");

    // Never fewer beds than the people living in the room.
    const living = await Member.countDocuments({ assignedRoom_id: room._id, ...LIVING });
    if (sharing_cap < living) return res.status(400).send(`${living} tenant${living === 1 ? " lives" : "s live"} in room ${room.room_number}, so it needs at least ${living} bed${living === 1 ? "" : "s"}.`);

    await Room.updateOne({ _id: room._id, user: userId }, { $set: { room_fees, sharing_capacity: sharing_cap } });
    await syncRoomAndFloor(room._id);

    res.redirect("/user/managerooms");
  } catch (err) {
    console.error("room update error:", err.message);
    res.status(500).send("Update failed. Please try again.");
  }
});

router.delete("/managerooms/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!isId(req.params.id)) return res.status(404).send("Room not found.");
    const room = await Room.findOne({ _id: req.params.id, user: userId });
    if (!room) return res.status(404).send("Room not found.");

    // A room that people live in cannot be deleted: move them out first.
    const living = await Member.countDocuments({ assignedRoom_id: room._id, ...LIVING });
    if (living) return res.status(400).send(`${living} tenant${living === 1 ? " lives" : "s live"} in room ${room.room_number}. Move ${living === 1 ? "them" : "them"} out before deleting the room.`);

    await Room.deleteOne({ _id: room._id, user: userId });
    await syncFloor(room.floor_id).catch(e => console.error("Floor count (non-fatal):", e.message));
    res.redirect("/user/managerooms");
  } catch (err) {
    console.error("room delete error:", err.message);
    res.status(500).send("Delete failed. Please try again.");
  }
});

// ============================================================
//  MEMBERS (tenants)
// ============================================================
router.get("/members", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const members = await Member.find({ user: userId, hostel: selectedHostel, ...NOT_REMOVED }).populate("payments");
    safeRender(res, "showPage/memberData/Allmember.ejs", { allMembers: members, user });
  } catch (err) {
    console.error("members GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/member-edit/:id/edit", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);
    if (!isId(req.params.id)) return res.status(404).send("Member not found.");

    const [rooms, member] = await Promise.all([
      Room.find({ user: userId, hostel: selectedHostel }),
      Member.findOne({ _id: req.params.id, user: userId, ...NOT_REMOVED }).populate("payments")
    ]);

    if (!member) return res.status(404).send("Member not found.");
    safeRender(res, "showPage/memberData/Edit-Allmember.ejs", { allMembers: member, rooms, user });
  } catch (err) {
    console.error("member-edit GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.put("/member-edit/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId     = req.user.id;
    const memberBody = req.body.member || {};
    if (!isId(req.params.id)) return res.status(404).send("Member not found.");

    // Only these details can be changed here. Room, property, status, payments and the owner cannot.
    const set = {};
    if (typeof memberBody.name === "string") {
      const name = clean(memberBody.name, 100);
      if (!name) return res.status(400).send("Name is required.");
      set.name = name;
    }
    if (typeof memberBody.mobileNo === "string") {
      const mobileNo = memberBody.mobileNo.trim();
      if (!/^[6-9]\d{9}$/.test(mobileNo)) return res.status(400).send("Invalid mobile number.");
      // Phase 4: while KYC is required, a tenant's number can only change to a KYC-verified number.
      const kyc = require("../utils/kyc");
      const current = await Member.findOne({ _id: req.params.id, user: userId }, { mobileNo: 1 }).lean();
      if (current && current.mobileNo !== mobileNo && (await kyc.settings()).enforced) {
        const rec = await kyc.recordFor(mobileNo);
        if (!kyc.verifiedFor(rec, userId)) return res.status(400).send("KYC is required: the new mobile number must be verified with DigiLocker first.");
      }
      set.mobileNo = mobileNo;
    }
    for (const k of ["fatherName", "aadharNo", "address", "profession"]) {
      if (typeof memberBody[k] === "string") set[k] = clean(memberBody[k], k === "address" ? 500 : 100);
    }

    const updated = await Member.findOneAndUpdate({ _id: req.params.id, user: userId, ...NOT_REMOVED }, { $set: set }, { new: true, runValidators: true });
    if (!updated) return res.status(404).send("Member not found.");
    res.redirect("/user/members");
  } catch (err) {
    console.error("member update error:", err.message);
    if (err.name === "ValidationError") return res.status(400).send("Validation Error: " + err.message);
    res.status(500).send("Server Error.");
  }
});

// "Remove" a tenant: hidden from the lists, the bed is freed, the record and payments are kept.
router.delete("/member/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!isId(req.params.id)) return res.status(404).send("Member not found.");
    const now = new Date();

    const member = await Member.findOneAndUpdate(
      { _id: req.params.id, user: userId, ...NOT_REMOVED },
      { $set: { removedAt: now, status: "Inactive" } },
      { new: false }
    );
    if (!member) return res.redirect("/user/members");   // already removed: nothing to do
    if (!member.leftDate) await Member.updateOne({ _id: member._id }, { $set: { leftDate: now } });

    if (member.assignedRoom_id) await syncRoomAndFloor(member.assignedRoom_id);
    res.redirect("/user/members");
  } catch (err) {
    console.error("member delete error:", err.message);
    res.status(500).send("Delete failed. Please try again.");
  }
});

router.get("/activeMember", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel, ...NOT_REMOVED });
    safeRender(res, "showPage/memberData/activeMember.ejs", { allMembers, user });
  } catch (err) {
    console.error("activeMember error:", err.message);
    res.status(500).send("Server Error.");
  }
});

// Move out. Opening the old link no longer changes anything; the button on Active Tenants sends a POST after a confirm.
router.get("/activeMember/:id", jwtAuthMiddleware, (req, res) => res.redirect("/user/activeMember"));

router.post("/activeMember/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!isId(req.params.id)) return res.status(404).send("Member not found.");

    // Only a tenant who still lives here can move out, and only once.
    const member = await Member.findOneAndUpdate(
      { _id: req.params.id, user: userId, ...LIVING },
      { $set: { status: "Inactive", leftDate: new Date() } },
      { new: true }
    );
    if (member && member.assignedRoom_id) await syncRoomAndFloor(member.assignedRoom_id);
    res.redirect("/user/activeMember");
  } catch (err) {
    console.error("activeMember move-out error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/newmember", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;

    const [rooms, floors] = await Promise.all([
      selectedHostel ? Room.find({ user: userId, hostel: selectedHostel }) : [],
      selectedHostel ? Floor.find({ user: userId, hostel: selectedHostel }) : []
    ]);

    // Phase 3 — "Convert" from Leads & CRM: pre-fill from the owner's own enquiry.
    let prefill = null;
    if (req.query.enquiry) {
      const e = await loadOwnedEnquiry(String(req.query.enquiry), userId).catch(() => null);
      if (e) {
        const st = e.student || {};
        prefill = {
          enquiryId: String(e._id),
          name: [st.firstName, st.lastName].filter(Boolean).join(" "),
          mobileNo: indianMobile(st.phone),
          listingTitle: e.listing?.title || "",
        };
      }
    }
    // Phase 2: each room with its floor, rent and free beds (from the bed map); a bed picked there comes pre-selected.
    let roomChoices = null, bedPick = null;
    if (selectedHostel) {
      try {
        const map = await require("../utils/beds").buildBedMap(userId, selectedHostel);
        const wantRoom = String(req.query.room || ""), wantBed = String(req.query.bed || "");
        roomChoices = [];
        for (const f of map.floors) for (const r of f.rooms) {
          roomChoices.push({ id: r.id, free: r.free, selected: r.id === wantRoom && r.free > 0,
            label: `${r.number} · ${f.name} · ₹${r.rent.toLocaleString("en-IN")}/bed · ${r.free ? (r.free === 1 ? "1 bed free" : r.free + " beds free") : "full"}` });
          const bed = r.id === wantRoom ? r.beds.find(b => b.label === wantBed && !b.member && !b.blocked) : null;
          if (bed) bedPick = { label: bed.label, room: r.number, roomId: r.id };
        }
      } catch (e) { console.error("newmember rooms (non-fatal):", e.message); roomChoices = null; }
    }
    safeRender(res, "showPage/memberData/newmember.ejs", { rooms, floors, user, prefill, roomChoices, bedPick });
  } catch (err) {
    console.error("newmember GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.post("/newMember", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const selectedHostel = res.locals.selectedHostel?._id;
    const m              = req.body.member || {};

    const { assignedRoom_id, name, fatherName, mobileNo, aadharNo, address, profession } = m;

    if (!selectedHostel) return needProperty(res);
    if (!assignedRoom_id || !isId(String(assignedRoom_id)) || !clean(name || "") || !mobileNo) {
      return res.status(400).send("Room, name, and mobile number are required.");
    }
    if (!/^[6-9]\d{9}$/.test(String(mobileNo))) {
      return res.status(400).send("Invalid mobile number.");
    }
    // Joining date: a real date, not more than a year away either way. Empty = today.
    let joiningDate = m.joiningDate ? new Date(m.joiningDate) : new Date();
    if (isNaN(joiningDate) || Math.abs(joiningDate - Date.now()) > 366 * 864e5) return res.status(400).send("Enter a valid joining date.");

    // The room must be this owner's, in the property they are working in.
    const room = await Room.findOne({ _id: assignedRoom_id, user: userId, hostel: selectedHostel });
    if (!room) return res.status(404).send("Room not found.");
    // Phase 2: a free (not blocked) bed — the one picked on the bed map if it is still free, else the first free one.
    const { ensureBeds, bedRent } = require("../utils/beds");
    const beds = await ensureBeds(room.toObject());
    const freeBeds = beds.filter(b => !b.member && !b.blocked);
    if (!freeBeds.length) return res.status(400).send("This room is full. Please choose another room.");
    const bed = freeBeds.find(b => b.label === String(m.bedLabel || "")) || freeBeds[0];
    const rent = bedRent(room, bed.label);

    // A new tenant lives here from today: "Active". (Unpaid rent shows as dues, not as a different status.)
    const newMember = new Member({
      user: userId, hostel: selectedHostel,
      assignedRoom_id: room._id, name: clean(name, 100), fatherName: clean(fatherName || "", 100),
      mobileNo: String(mobileNo), aadharNo: clean(aadharNo || "", 20), address: clean(address || "", 500),
      profession: clean(profession || "", 100), joiningDate,
      assignedRoom: room.room_number, bedLabel: bed.label, status: "Active"
    });
    await newMember.validate();   // check everything before saving anything, so no half-saved records

    // The joining month's rent, dated on the joining day and marked with its month, so the
    // monthly job (utils/monthlyRent.js) charges the following months and never this one again.
    const newPayment = new Payment({ user: userId, memberId: newMember._id, roomId: room._id, roomFees: rent, totalFees: rent, dueAmount: rent,
      paymentDate: joiningDate, payableDate: joiningDate, chargeMonth: moment(joiningDate).tz(TZ).format("YYYY-MM") });
    await newPayment.save();
    newMember.payments.push(newPayment._id);
    try {
      await newMember.save();
    } catch (e) {
      await Payment.deleteOne({ _id: newPayment._id }).catch(() => {});
      throw e;
    }
    // Two admissions into the same bed at the same moment: the later one gets the next free bed.
    await ensureBeds((await Room.findById(room._id).lean()) || room.toObject()).catch(() => {});
    await syncRoomAndFloor(room._id);

    // Phase 3 — tenant added from an enquiry ("Convert"): close that enquiry.
    // Only runs when the form carried an enquiry id; never throws.
    if (req.body.enquiryId) await closeEnquiryAfterConvert(req.body.enquiryId, userId, newMember._id);

    res.redirect("/user/newAdded/successfully");
  } catch (err) {
    console.error("newMember POST error:", err.message);
    if (err.name === "ValidationError") return res.status(400).send("Validation Error: " + err.message);
    res.status(500).send("Error saving member. Please try again.");
  }
});

router.get("/newAdded/successfully", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    safeRender(res, "showPage/memberData/newmemberADDED.ejs", { user });
  } catch (err) {
    res.redirect("/user/members");
  }
});

// ============================================================
//  PAYMENTS
// ============================================================
router.get("/members/:id/addpayment", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user   = await Owner.findById(req.user.id);
    if (!isId(req.params.id)) return res.status(404).send("Member not found.");
    const member = await Member.findOne({ _id: req.params.id, user: req.user.id, ...NOT_REMOVED }).populate('payments');
    if (!member) return res.status(404).send("Member not found.");

    const dueAmount = money(member).due;
    safeRender(res, "payments/addpayment.ejs", { member, dueAmount, user });
  } catch (err) {
    console.error("addpayment GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.post("/addpayment/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const p      = req.body.payment || {};

    const amountPaid  = moneyIn(p.amountPaid);
    const paymentMode = clean(p.paymentMode || "", 30);

    if (!isId(id)) return res.status(404).send("Member not found.");
    if (amountPaid === null || amountPaid <= 0) return res.status(400).send("Amount paid must be greater than 0.");
    if (!paymentMode)    return res.status(400).send("Payment mode is required.");

    // Payment date: a real date, not in the future. Empty = now.
    let paymentDate = p.paymentDate ? new Date(p.paymentDate) : new Date();
    if (isNaN(paymentDate)) return res.status(400).send("Enter a valid payment date.");
    if (paymentDate - Date.now() > 864e5) return res.status(400).send("The payment date cannot be in the future.");

    const member = await Member.findOne({ _id: id, user: userId, ...NOT_REMOVED });
    if (!member) return res.status(404).send("Member not found.");

    // The same payment sent twice within a few seconds (double click, refresh) is recorded once.
    const recent = await Payment.findOne({
      memberId: member._id, amountPaid, paymentMode,
      _id: { $gt: mongoose.Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 15) },
    }).sort({ _id: -1 });
    if (recent) return res.redirect(`/user/payment-receipt/${recent._id}`);

    const saved = await new Payment({ user: userId, memberId: member._id, amountPaid, paymentMode, paymentDate, status: "Paid" }).save();

    // Record it on the tenant. A tenant who has moved out stays moved out (paying old dues does not move them back in).
    const set = member.leftDate ? {} : { status: "Active" };
    await Member.updateOne({ _id: member._id }, { $addToSet: { payments: saved._id }, ...(member.leftDate ? {} : { $set: set }) });

    res.redirect(`/user/payment-receipt/${saved._id}`);
  } catch (err) {
    console.error("addpayment POST error:", err.message);
    res.status(500).send("Internal Server Error. Please try again.");
  }
});

router.get("/payment-receipt/:paymentId", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user    = await Owner.findById(req.user.id);
    if (!isId(req.params.paymentId)) return res.status(404).send("Payment not found.");
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) return res.status(404).send("Payment not found.");

    // Only the owner of that tenant may see the receipt.
    const member = await Member.findOne({ _id: payment.memberId, user: req.user.id });
    if (!member) return res.status(404).send("Payment not found.");

    safeRender(res, "payments/paymentreciept.ejs", { member, payment, user });
  } catch (err) {
    console.error("payment-receipt error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

// Search by name or mobile (part of either), inside the property being worked on.
async function searchMembers(userId, hostelId, text) {
  const q = clean(text || "", 60);
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const or = [{ name: { $regex: escapeRegex(q), $options: "i" } }];
  if (digits.length >= 3) or.push({ mobileNo: { $regex: escapeRegex(digits) } });
  const filter = { user: userId, ...NOT_REMOVED, $or: or };
  if (hostelId) filter.hostel = hostelId;
  return Member.find(filter).populate("payments").limit(200);
}

router.post("/member/search", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId      = req.user.id;
    const user        = await Owner.findById(userId);
    const searchQuery = clean(req.body.name || "", 60);

    if (!searchQuery) return res.status(400).send("Search query is required.");

    const members = await searchMembers(userId, res.locals.selectedHostel?._id, searchQuery);

    if (!members.length) {
      return safeRender(res, "showPage/memberData/searchedNotFoundMember.ejs", { user, errorMessage: "Member not found." });
    }
    safeRender(res, "showPage/memberData/searchedMember.ejs", { allMembers: members, user });
  } catch (err) {
    console.error("member search error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/allfeesrecords", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel, ...NOT_REMOVED }).populate("payments").sort({ _id: -1 });
    safeRender(res, "payments/allrecords.ejs", { allMembers: withMoney(allMembers), user });
  } catch (err) {
    console.error("allfeesrecords error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

router.post("/searchfeesrecords", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId      = req.user.id;
    const user        = await Owner.findById(userId);
    const searchQuery = clean(req.body.searchQuery || "", 60);

    const filtered = await searchMembers(userId, res.locals.selectedHostel?._id, searchQuery);
    const membersWithFees = withMoney(filtered);

    if (!membersWithFees.length) {
      return safeRender(res, "payments/allrecordsNotFound.ejs", { allMembers: [], errorMessage: "No records found.", user });
    }
    safeRender(res, "payments/allrecords.ejs", { allMembers: membersWithFees, errorMessage: null, user });
  } catch (err) {
    console.error("searchfeesrecords error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

router.get('/payment-history/:memberId', jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user     = await Owner.findById(req.user.id);
    if (!isId(req.params.memberId)) return res.status(404).send("Member not found.");
    const member   = await Member.findOne({ _id: req.params.memberId, user: req.user.id });
    if (!member) return res.status(404).send("Member not found.");
    const payments = await Payment.find({ memberId: member._id }).sort({ paymentDate: -1 });
    safeRender(res, 'payments/PaymentHistoryOfOne.ejs', { member, payments, user });
  } catch (err) {
    console.error("payment-history error:", err.message);
    res.status(500).send('Server Error.');
  }
});

// Rent due today or in the next 5 days (India time), for tenants who live here.
router.get("/upcomingPayments", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const today = moment().tz(TZ).startOf("day");
    const last  = today.clone().add(5, "days");
    const members = await Member.find({ user: userId, hostel: selectedHostel, ...LIVING }).populate('payments');
    const upcoming = members
      .map(m => ({ m, due: nextDueDate(dueAnchor(m)) }))   // Phase 3: own due day
      .filter(x => x.due && !x.due.isAfter(last))
      .sort((a, b) => a.due - b.due)
      .map(x => Object.assign(x.m, { nextDue: x.due.toDate() }));

    safeRender(res, "payments/upcomingPayments.ejs", { allMembers: upcoming, user });
  } catch (err) {
    console.error("upcomingPayments error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

// Dues: every tenant who owes money, most owed first.
router.get("/deureports", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel, ...NOT_REMOVED }).populate("payments");
    const dues = withMoney(allMembers)
      .filter(m => m.dueAmount > 0)
      .sort((a, b) => b.dueAmount - a.dueAmount)
      .map(m => {
        // The oldest month not yet covered by payments (charges paid oldest first).
        const charges = (m.payments || []).filter(p => p && Number(p.roomFees) > 0)
          .sort((a, b) => new Date(a.paymentDate || 0) - new Date(b.paymentDate || 0));
        let paid = m.amountPaid, since = null;
        for (const c of charges) { if (paid >= c.roomFees) { paid -= c.roomFees; continue; } since = c.paymentDate || null; break; }
        return { ...m, dueSince: since, movedOut: !!m.leftDate };
      });
    const total = dues.reduce((s, m) => s + m.dueAmount, 0);
    safeRender(res, "payments/duesReport.ejs", { dues, total, user });
  } catch (err) {
    console.error("deureports error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

// ============================================================
//  REVENUE
// ============================================================
router.get("/revenue", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return needProperty(res);

    const fmt = n => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
    const empty = { totalExpectedRevenue: fmt(0), totalFeesCollected: fmt(0), totalPendingAmount: fmt(0), totalAdvancedPaid: fmt(0), balance: fmt(0), paidAccounts: 0, dueAccounts: 0, feesCollectionCompleted: 0, user };

    // Removed tenants are included for what they paid (money really collected), not for unpaid rent.
    const allMembers = withMoney(await Member.find({ user: userId, hostel: selectedHostel }).populate("payments"));
    if (!allMembers.length) return safeRender(res, "payments/revenue", empty);

    let totalExpectedRevenue = 0, totalFeesCollected = 0,
        totalPendingAmount   = 0, totalAdvancedPaid   = 0,
        paidAccounts         = 0, dueAccounts         = 0;

    allMembers.forEach(m => {
      totalExpectedRevenue += m.totalFees;
      totalFeesCollected   += m.amountPaid;
      totalPendingAmount   += m.dueAmount;
      totalAdvancedPaid    += m.advancedPaid;
      if (m.removedAt) return;
      m.dueAmount > 0 ? dueAccounts++ : paidAccounts++;
    });

    const balance = totalExpectedRevenue - totalFeesCollected;
    const feesCollectionCompleted = totalExpectedRevenue > 0
      ? Math.min(100, Math.round((totalFeesCollected / totalExpectedRevenue) * 100)) : 0;

    safeRender(res, "payments/revenue", {
      totalExpectedRevenue: fmt(totalExpectedRevenue),
      totalFeesCollected:   fmt(totalFeesCollected),
      totalPendingAmount:   fmt(totalPendingAmount),
      totalAdvancedPaid:    fmt(totalAdvancedPaid),
      balance:              fmt(balance),
      feesCollectionCompleted, paidAccounts, dueAccounts, user
    });
  } catch (err) {
    console.error("revenue error:", err.message);
    res.status(500).send("Server Error.");
  }
});

// ============================================================
//  FORGOT / RESET PASSWORD
// ============================================================
router.get("/forgot-password", (req, res) => {
  safeRender(res, "authPrivate/forgotPassword.ejs", {});
});

router.post("/forgot-password", async (req, res) => {
  try {
    const email = clean(req.body.email || "").toLowerCase();
    if (!email || !validator.isEmail(email)) {
      return safeRender(res, "authPrivate/forgotPassword.ejs", { error: "Please enter a valid email address." });
    }

    const user = await Owner.findOne({ email });
    // Always show same message to prevent user enumeration
    const successMsg = "If this email exists, a reset link has been sent. Check your inbox.";

    if (!user) {
      return safeRender(res, "authPrivate/forgotPassword.ejs", { message: successMsg });
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken   = token;
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const resetLink = `${process.env.BASE_URL || "https://manage.hostelnode.com"}/user/reset-password/${token}`;
    sendMail(user.email, "Reset Your Password - HostelNode",
      `<div style="font-family:Arial;padding:20px">
        <h2>🔐 Reset Your Password</h2>
        <p>Hello ${user.name},</p>
        <p>Click the button below to reset your password. This link expires in 15 minutes.</p>
        <a href="${resetLink}" style="display:inline-block;padding:12px 20px;background:#09B850;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">Reset Password</a>
        <p style="margin-top:15px;color:#555;">If you didn't request this,ignore this email.</p>
      </div>`
    );

    safeRender(res, "authPrivate/forgotPassword.ejs", { message: successMsg });
  } catch (err) {
    console.error("forgot-password error:", err.message);
    res.status(500).send("Server Error. Please try again.");
  }
});

router.get("/reset-password/:token", async (req, res) => {
  try {
    const user = await Owner.findOne({
      resetPasswordToken:   req.params.token,
      resetPasswordExpires: { $gt: new Date() }
    });
    if (!user) return res.send("❌ This reset link has expired or is invalid. Please request a new one.");
    safeRender(res, "authPrivate/resetPassword.ejs", { token: req.params.token });
  } catch (err) {
    console.error("reset-password GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.post("/reset-password/:token", async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;

    if (!password) return res.status(400).send("Password is required.");
    if (password !== confirmPassword) {
      return safeRender(res, "authPrivate/resetPassword.ejs", {
        error: "Passwords do not match.", token: req.params.token
      });
    }
    if (!validator.isStrongPassword(password, { minLength: 6, minNumbers: 1 })) {
      return safeRender(res, "authPrivate/resetPassword.ejs", {
        error: "Password must be at least 6 characters with at least 1 number.", token: req.params.token
      });
    }

    const user = await Owner.findOne({
      resetPasswordToken:   req.params.token,
      resetPasswordExpires: { $gt: new Date() }
    });
    if (!user) return res.send("❌ Reset link expired or invalid. Please request a new one.");

    user.password             = await bcrypt.hash(password, 10);
    user.resetPasswordToken   = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    sendMail(user.email, "✅ Password Changed - HostelNode",
      `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#09B850;">Password Updated ✅</h2>
        <p>Hello ${user.name}, your password has been successfully changed.</p>
        <p style="color:red;"><b>⚠️ If you did NOT do this, contact support immediately.</b></p>
      </div>`
    );

    res.redirect("/login");
  } catch (err) {
    console.error("reset-password POST error:", err.message);
    res.status(500).send("Error resetting password. Please try again.");
  }
});

// ============================================================
//  LIST PROPERTY
// ============================================================
router.get("/list-property", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId  = req.user.id;
    const user    = await Owner.findById(userId);
    const hostels = await Hostel.find({ owner: userId });
    safeRender(res, "listings/listproperty.ejs", { user, hostels, selectedHostel: res.locals.selectedHostel });
  } catch (err) {
    console.error("list-property GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

// ── Multer listing upload middleware with error handling ──
const listingUploadMiddleware = (req, res, next) => {
  listingUpload.array("images", 15)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE")
        return res.status(400).json({ ok: false, message: "Each photo must be under 5 MB. Please compress your images and try again." });
      if (err.code === "LIMIT_FILE_COUNT")
        return res.status(400).json({ ok: false, message: "You can upload a maximum of 15 photos." });
      return res.status(400).json({ ok: false, message: `Upload error: ${err.message}` });
    }
    
    if (err?.isFileTypeError)
      return res.status(400).json({ ok: false, message: err.message });
    console.error("❌ Listing upload error:", err?.message);
    return res.status(500).json({ ok: false, message: "Photo upload failed. Please try again." });
  });
};

router.post("/new-list-property", jwtAuthMiddleware, attachHostel, listingUploadMiddleware, async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ ok: false, message: "Session expired. Please log in again." });
    const userId = req.user.id;

    // ── Sanitise all inputs ──
    const title        = clean(req.body.title        || "", 80);
    const description  = clean(req.body.description  || "", 1000);
    const propertyType = clean(req.body.propertyType || "Hostel");
    const gender       = clean(req.body.gender       || "");
    const rawPrice     = req.body.startingPrice;
    const rawDeposit   = req.body.deposit;
    const rawCapacity  = req.body.capacity;

    let amenities = req.body.amenities || [];
    if (!Array.isArray(amenities)) amenities = [amenities];
    amenities = amenities.map(a => clean(a)).filter(Boolean).slice(0, 30);

    let rules = req.body.rules || [];
    if (!Array.isArray(rules)) rules = [rules];
    rules = rules.map(r => clean(r, 200)).filter(Boolean).slice(0, 30);

    const location = {
      address:     clean(req.body["location[address]"]     || req.body.location?.address     || ""),
      city:        clean(req.body["location[city]"]        || req.body.location?.city        || ""),
      state:       clean(req.body["location[state]"]       || req.body.location?.state       || ""),
      country:     clean(req.body["location[country]"]     || req.body.location?.country     || "India"),
      pincode:     clean(req.body["location[pincode]"]     || req.body.location?.pincode     || ""),
      nearCollege: clean(req.body["location[nearCollege]"] || req.body.location?.nearCollege || ""),
      coordinates: {
        lat: parseFloat(req.body["location[coordinates][lat]"] || req.body.location?.coordinates?.lat) || null,
        lng: parseFloat(req.body["location[coordinates][lng]"] || req.body.location?.coordinates?.lng) || null,
      }
    };

    const contact = {
      phone:    clean(req.body["contact[phone]"]    || req.body.contact?.phone    || ""),
      whatsapp: clean(req.body["contact[whatsapp]"] || req.body.contact?.whatsapp || ""),
    };

    let rooms = [];
    try {
      rooms = Object.values(req.body.rooms || {}).map(r => ({
        type:      clean(r.type || ""),
        price:     toNum(r.price),
        deposit:   toNum(r.deposit),
        features:  (Array.isArray(r.features) ? r.features : r.features ? [r.features] : []).map(f => clean(f)),
        available: r.available === "true" || r.available === true
      })).filter(r => r.type).slice(0, 20);
    } catch (_) { rooms = []; }

    // ── Validation ──
    if (!title)                   return res.status(400).json({ ok: false, message: "Property title is required." });
    if (title.length > 80)        return res.status(400).json({ ok: false, message: "Title must be 80 characters or less." });
    if (!["Boys","Girls","Co-ed"].includes(gender)) return res.status(400).json({ ok: false, message: "Please select who the property is for." });
    if (!["Hostel","PG","Flat"].includes(propertyType)) return res.status(400).json({ ok: false, message: "Invalid property type." });

    const startingPrice = toNum(rawPrice);
    if (!rawPrice || startingPrice < 100) return res.status(400).json({ ok: false, message: "Starting price must be at least ₹100/month." });
    if (startingPrice > 500000)           return res.status(400).json({ ok: false, message: "Starting price seems too high. Max ₹5,00,000." });

    if (!location.address)     return res.status(400).json({ ok: false, message: "Full address is required." });
    if (!location.nearCollege) return res.status(400).json({ ok: false, message: "Nearest college/place is required." });
    if (!location.city)        return res.status(400).json({ ok: false, message: "City is required." });
    if (location.pincode && !/^\d{6}$/.test(location.pincode)) return res.status(400).json({ ok: false, message: "Pincode must be 6 digits." });

    const hasCoords = location.coordinates.lat !== null && location.coordinates.lng !== null &&
      !isNaN(location.coordinates.lat) && !isNaN(location.coordinates.lng);
    if (!hasCoords) return res.status(400).json({ ok: false, message: "Please pin your location on the map and confirm it." });

    if (!contact.phone || !/^[6-9]\d{9}$/.test(contact.phone))
      return res.status(400).json({ ok: false, message: "A valid 10-digit contact phone number is required." });

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ ok: false, message: "Please upload at least one photo." });

    const deposit  = toNum(rawDeposit);
    const capacity = rawCapacity ? toNum(rawCapacity) : undefined;

    const newListing = new Listing({
      owner: userId, title, description, propertyType, gender,
      startingPrice, deposit, capacity, location, rooms,
      images: req.files.map(f => f.filename),
      amenities, rules, contact,
      // Subscriptions: at the plan's listing limit the listing is saved as a
      // hidden draft (Middlewares/planGate.js sets req.hnPlanHold).
      status: req.hnPlanHold ? "Pending" : "Approved",
      planHold: !!req.hnPlanHold
    });
    await newListing.save();

    if (req.hnPlanHold) {
      // The form is sent by script and then opens My Listings, where the upgrade popup shows once.
      if (req.session) req.session.hnUpgradeOnce = "maxListings";
      return res.status(201).json({ ok: true, held: true });
    }

    const user = await Owner.findById(userId).lean();

    // Email (non-blocking)
    sendMail(user.email, "🏠 Your Listing is Created - HostelNode",
      `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#09B850;">Listing Created Successfully ✅</h2>
        <p>Hi ${user.name}, your listing <b>${newListing.title}</b> has been created and is under review.</p>
        <p><b>₹${newListing.startingPrice.toLocaleString("en-IN")}/month</b> · ${newListing.location.city}, ${newListing.location.state}</p>
      </div>`
    );

    return safeRender(res.status(201), "listings/listingSuccess.ejs", { user, listing: newListing });

  } catch (err) {
    console.error("❌ create listing error:", err.message);
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors)[0]?.message || "Validation failed.";
      return res.status(400).json({ ok: false, message: "Validation error: " + msg });
    }
    if (err.code === 11000) return res.status(409).json({ ok: false, message: "A listing with this information already exists." });
    if (err.name === "MongoNetworkError") return res.status(503).json({ ok: false, message: "Database connection issue. Please try again." });
    res.status(500).json({ ok: false, message: "Something went wrong. Please try again." });
  }
});


// ============================================================
//  MY LISTINGS
// ============================================================
router.get("/my-listings", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user     = await Owner.findById(req.user.id);
    const listings = await Listing.find({ owner: req.user.id }).sort({ createdAt: -1 });
    const listingIds = listings.map(l => l._id);

    const enquiries = await Enquiry.find({ listing: { $in: listingIds } })
      .populate("student", "firstName lastName phone profileImage")
      .sort({ createdAt: -1 });

    const listingsWithData = listings.map(l => {
      const relatedEnquiries = enquiries
        .filter(e => e.listing.toString() === l._id.toString())
        .map(e => ({
          _id:           e._id,
          name:          e.student ? `${e.student.firstName} ${e.student.lastName}` : "Anonymous",
          phone:         e.student?.phone || "",
          roomType:      e.roomType,
          moveIn:        e.moveIn,
          preferredDate: e.preferredDate,
          contactMethod: e.contactMethod,
          message:       e.message,
          avatar:        e.student?.profileImage || "default-avatar.png",
          createdAt:     e.createdAt,
          seen:          e.status !== "New"
        }));
      return { ...l.toObject(), enquiries: relatedEnquiries };
    });

    safeRender(res, "listings/myListings.ejs", { user, listings: listingsWithData, selectedHostel: res.locals.selectedHostel });
  } catch (err) {
    console.error("my-listings error:", err.message);
    res.status(500).send("Server Error.");
  }
});

// ============================================================
//  DELETE LISTING
// ============================================================
router.post("/listing/:id/delete", jwtAuthMiddleware, async (req, res) => {
  try {
    const { id }  = req.params;
    const userId  = req.user.id;
    const listing = await Listing.findOneAndDelete({ _id: id, owner: userId });
    if (!listing) return res.status(404).send("Listing not found or you are not authorized.");

    // Delete files — never crash if a file is missing
    (listing.images || []).forEach(img => {
      try {
        const p = path.join(listingUploadDir, img);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (fileErr) {
        console.error("File delete error (non-fatal):", fileErr.message);
      }
    });
    res.redirect("/user/my-listings");
  } catch (err) {
    console.error("delete listing error:", err.message);
    res.status(500).send("Server Error.");
  }
});

// ============================================================
//  EDIT LISTING (GET)
// ============================================================
router.get('/listing/:id/edit', jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId  = req.user.id;
    const listing = await Listing.findOne({ _id: req.params.id, owner: userId });
    if (!listing) return res.status(404).send("Listing not found or you are not authorized.");

    const user    = await Owner.findById(userId);
    const hostels = await Hostel.find({ owner: userId });
    safeRender(res, "listings/editListing.ejs", { listing, user, hostels, selectedHostel: res.locals.selectedHostel });
  } catch (err) {
    console.error("listing edit GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

// ============================================================
//  EDIT LISTING (POST)
// ============================================================
router.post('/listing/:id/edit', jwtAuthMiddleware, listingUploadMiddleware, async (req, res) => {
  try {
    const userId  = req.user.id;
    const listing = await Listing.findOne({ _id: req.params.id, owner: userId });
    if (!listing) return res.status(404).send("Not found or unauthorized.");

    listing.title        = clean(req.body.title        || listing.title,  80);
    listing.description  = clean(req.body.description  || listing.description, 1000);
    listing.propertyType = req.body.propertyType || listing.propertyType;
    listing.gender       = req.body.gender       || listing.gender;
    listing.startingPrice = toNum(req.body.startingPrice) || listing.startingPrice;
    listing.deposit       = toNum(req.body.deposit) || listing.deposit;
    listing.capacity      = toNum(req.body.capacity) || listing.capacity;

    // Location (safe update — only overwrite what's provided)
    if (!listing.location) listing.location = {};
    const loc = req.body.location || {};
    if (loc.address)     listing.location.address     = clean(loc.address);
    if (loc.city)        listing.location.city        = clean(loc.city);
    if (loc.state)       listing.location.state       = clean(loc.state);
    if (loc.country)     listing.location.country     = clean(loc.country);
    if (loc.pincode)     listing.location.pincode     = clean(loc.pincode);
    if (loc.nearCollege) listing.location.nearCollege = clean(loc.nearCollege);

    const lat = parseFloat(loc.coordinates?.lat);
    const lng = parseFloat(loc.coordinates?.lng);
    if (!isNaN(lat) && lat !== 0) listing.location.coordinates.lat = lat;
    if (!isNaN(lng) && lng !== 0) listing.location.coordinates.lng = lng;

    // Contact
    if (!listing.contact) listing.contact = {};
    if (req.body.contact?.phone)    listing.contact.phone    = clean(req.body.contact.phone);
    if (req.body.contact?.whatsapp) listing.contact.whatsapp = clean(req.body.contact.whatsapp);

    // Rooms
    try {
      // Phase 2: a room type keeps its link to the property's rooms (picked rooms, free beds) when the listing is edited.
      const oldTypes = new Map((listing.rooms || []).map(r => [String(r.type || "").trim().toLowerCase(), r]));
      listing.rooms = Object.values(req.body.rooms || {}).map(r => {
        const type = clean(r.type || "");
        const was = oldTypes.get(type.trim().toLowerCase());
        return {
          type,
          price:     toNum(r.price),
          deposit:   toNum(r.deposit),
          features:  (Array.isArray(r.features) ? r.features : r.features ? [r.features] : []).map(f => clean(f)),
          available: r.available === "true" || r.available === true,
          roomIds:   was && was.roomIds ? Array.from(was.roomIds) : [],
          freeBeds:  was && typeof was.freeBeds === "number" ? was.freeBeds : null
        };
      }).filter(r => r.type).slice(0, 20);
    } catch (_) { /* keep existing rooms */ }

    // Amenities / Rules
    if (req.body.amenities) {
      listing.amenities = (Array.isArray(req.body.amenities) ? req.body.amenities : [req.body.amenities]).map(a => clean(a)).slice(0, 30);
    }
    if (req.body.rules) {
      listing.rules = (Array.isArray(req.body.rules) ? req.body.rules : [req.body.rules]).map(r => clean(r, 200)).filter(Boolean).slice(0, 30);
    }

    // New images
    if (req.files?.length > 0) {
      listing.images = [...(listing.images || []), ...req.files.map(f => f.filename)];
    }

    // Delete images
    if (req.body.deleteImages) {
      const toDelete = Array.isArray(req.body.deleteImages) ? req.body.deleteImages : [req.body.deleteImages];
      listing.images = (listing.images || []).filter(img => !toDelete.includes(img));
      toDelete.forEach(img => {
        try {
          const p = path.join(listingUploadDir, img);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (fe) { console.error("File delete error (non-fatal):", fe.message); }
      });const uploadDir = '/secure_uploads/profiles';
    }

    listing.status = listing.planHold ? "Pending" : "Approved";   // a hidden draft stays hidden when edited
    await listing.save();
    if (listing.linkedHostel) await require("../utils/beds").refreshListings(listing.linkedHostel);   // Phase 2: free beds for any renamed/new room type
    res.redirect("/user/my-listings");

  } catch (err) {
    console.error("listing edit POST error:", err.message);
    if (err.name === "ValidationError") return res.status(400).send("Validation Error: " + err.message);
    res.status(500).send("Server Error.");
  }
});

// ============================================================
//  DELETE REVIEW
// ============================================================
router.delete("/listing/:listingId/review/:reviewId", jwtAuthMiddleware, async (req, res) => {
  try {
    const { listingId, reviewId } = req.params;
    const listing = await Listing.findOne({ _id: listingId, owner: req.user.id });
    if (!listing) return res.status(404).json({ success: false, error: "Listing not found." });

    const before = listing.reviews.length;
    listing.reviews = listing.reviews.filter(r => r._id.toString() !== reviewId);
    if (listing.reviews.length === before) return res.status(404).json({ success: false, error: "Review not found." });

    listing.rating      = listing.reviews.length > 0
      ? Math.round((listing.reviews.reduce((s, r) => s + r.rating, 0) / listing.reviews.length) * 10) / 10
      : 0;
    listing.reviewCount = listing.reviews.length;
    await listing.save();

    res.json({ success: true, newRating: listing.rating, newReviewCount: listing.reviewCount });
  } catch (err) {
    console.error("delete review error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// ============================================================
//  SECURE PROFILE IMAGE
// ============================================================
router.get('/secure/profile/:filename', jwtAuthMiddleware, (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(uploadDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("Image not found.");
    res.sendFile(filePath);
  } catch (err) {
    console.error("Secure image error:", err.message);
    res.status(500).send("Server error.");
  }
});

// ============================================================
//  LOGOUT
// ============================================================
router.get("/logout", jwtAuthMiddleware, (req, res) => {
  try {
    res.clearCookie("token");
    res.redirect("/login");
  } catch (err) {
    res.redirect("/login");
  }
});

module.exports = router;




