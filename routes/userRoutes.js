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
const crypto = require('crypto');
const fs = require('fs');
const moment = require("moment-timezone");
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
      selectedHostel = await Hostel.findById(req.session.selectedHostel).catch(() => null);
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

    // Login alert email (non-blocking)
    sendMail(
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

    members.forEach(member => {
      const fees = (member.payments || []).reduce((s, p) => s + (p.roomFees   || 0), 0);
      const paid = (member.payments || []).reduce((s, p) => s + (p.amountPaid || 0), 0);
      const due  = Math.max(0, fees - paid);
      const adv  = Math.max(0, paid - fees);
      totalExpectedRevenue += fees;
      totalFeesCollected   += paid;
      totalPendingAmount   += due;
      totalAdvancedPaid    += adv;
      paid >= fees ? paidAccounts++ : dueAccounts++;
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
      totalStudents:           members.length,
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
router.get("hostelnode.com/hostel/:id", jwtAuthMiddleware, async (req, res) => {
  try {
    const hostelId = clean(req.params.id || "");
    if (!hostelId) return res.redirect("/user");
    req.session.selectedHostel = hostelId;
    res.redirect("/user");
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
    const floor_name     = clean(floorBody.floor_name || "");
    const userId         = req.user.id;
    const selectedHostel = res.locals.selectedHostel?._id || req.session?.selectedHostel;

    if (!floor_name) return res.status(400).send("Floor name is required.");
    if (!selectedHostel) return res.status(400).send("Please select a hostel first.");

    const existing = await Floor.findOne({ floor_name, user: userId, hostel: selectedHostel });
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

    if (!id) return res.status(400).send("Invalid floor ID.");

    await Floor.findOneAndDelete({ _id: id, user: userId, hostel: selectedHostel });
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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

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
    if (!selectedHostel) return res.status(400).send("Please select a hostel first.");

    const roomBody       = req.body.room || {};
    const floor_id       = roomBody.floor_id;
    const room_number    = clean(roomBody.room_number || "");
    const room_fees      = toNum(roomBody.room_fees);
    const sharing_cap    = toNum(roomBody.sharing_capacity);
    const occupied_beds  = toNum(roomBody.occupied_beds);

    if (!floor_id || !room_number) {
      return res.status(400).send("Floor and room number are required.");
    }
    if (sharing_cap < 1) return res.status(400).send("Sharing capacity must be at least 1.");
    if (occupied_beds > sharing_cap) return res.status(400).send("Occupied beds cannot exceed sharing capacity.");

    const floor = await Floor.findOne({ _id: floor_id, user: userId, hostel: selectedHostel });
    if (!floor) return res.status(404).send("Floor not found or you are not authorized.");

    const existing = await Room.findOne({ room_number, floor_id, hostel: selectedHostel });
    if (existing) return res.status(400).send(`Room "${room_number}" already exists on this floor.`);

    const newRoom = new Room({
      user: userId, hostel: selectedHostel, floor_id,
      floor_name: floor.floor_name, room_number, room_fees,
      sharing_capacity: sharing_cap, occupied_beds
    });
    await newRoom.save();

    await Floor.findByIdAndUpdate(floor_id, {
      $inc: { total_rooms: 1, total_beds: sharing_cap }
    });
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
    const { id }      = req.params;
    const roomBody    = req.body.room || {};
    const room_fees   = toNum(roomBody.room_fees);
    const sharing_cap = toNum(roomBody.sharing_capacity);

    const room = await Room.findById(id);
    if (!room) return res.status(404).send("Room not found.");
    if (sharing_cap < 1) return res.status(400).send("Sharing capacity must be at least 1.");

    await Floor.findByIdAndUpdate(room.floor_id, { $inc: { total_beds: -room.sharing_capacity } });
    await Room.findByIdAndUpdate(id, { room_fees, sharing_capacity: sharing_cap });
    await Floor.findByIdAndUpdate(room.floor_id, { $inc: { total_beds: sharing_cap } });

    res.redirect("/user/managerooms");
  } catch (err) {
    console.error("room update error:", err.message);
    res.status(500).send("Update failed. Please try again.");
  }
});

router.delete("/managerooms/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) return res.status(404).send("Room not found.");

    await Room.findByIdAndDelete(req.params.id);
    await Floor.findByIdAndUpdate(room.floor_id, {
      $inc: { total_rooms: -1, occupied_beds: -room.occupied_beds, total_beds: -room.sharing_capacity, active_number: -room.occupied_beds }
    });
    if (room.sharing_capacity === room.occupied_beds) {
      await Floor.findByIdAndUpdate(room.floor_id, { $inc: { occupied_rooms: -1 } });
    }
    res.redirect("/user/managerooms");
  } catch (err) {
    console.error("room delete error:", err.message);
    res.status(500).send("Delete failed. Please try again.");
  }
});

// ============================================================
//  MEMBERS
// ============================================================
router.get("/members", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const members = await Member.find({ user: userId, hostel: selectedHostel }).populate("payments");
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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const [rooms, member] = await Promise.all([
      Room.find({ user: userId, hostel: selectedHostel }),
      Member.findById(req.params.id).populate("payments")
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
    const memberBody   = req.body.member || {};
    const updatedMember = await Member.findByIdAndUpdate(req.params.id, { ...memberBody }, { new: true, runValidators: true });
    if (!updatedMember) return res.status(404).send("Member not found.");
    res.redirect("/user/members");
  } catch (err) {
    console.error("member update error:", err.message);
    if (err.name === "ValidationError") return res.status(400).send("Validation Error: " + err.message);
    res.status(500).send("Server Error.");
  }
});

router.delete("/member/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) return res.status(404).send("Member not found.");

    await Member.findByIdAndDelete(req.params.id);

    if (member.assignedRoom_id) {
      const room = await Room.findById(member.assignedRoom_id);
      if (room) {
        await Room.findByIdAndUpdate(member.assignedRoom_id, { $inc: { occupied_beds: -1 } });
        await Floor.findByIdAndUpdate(room.floor_id, { $inc: { active_number: -1, occupied_beds: -1 } });
      }
    }
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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel });
    safeRender(res, "showPage/memberData/activeMember.ejs", { allMembers, user });
  } catch (err) {
    console.error("activeMember error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.get("/activeMember/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) return res.status(404).send("Member not found.");

    member.status   = "Inactive";
    member.leftDate = new Date();
    await member.save();

    if (member.assignedRoom_id) {
      const room = await Room.findById(member.assignedRoom_id);
      if (room) {
        await Room.findByIdAndUpdate(member.assignedRoom_id, { $inc: { occupied_beds: -1 } });
        await Floor.findByIdAndUpdate(room.floor_id, { $inc: { active_number: -1, occupied_beds: -1 } });
      }
    }
    res.redirect("/user/members");
  } catch (err) {
    console.error("activeMember toggle error:", err.message);
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
    safeRender(res, "showPage/memberData/newmember.ejs", { rooms, floors, user });
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

    const { assignedRoom_id, name, fatherName, mobileNo, aadharNo, address, profession, joiningDate } = m;

    if (!assignedRoom_id || !name || !mobileNo) {
      return res.status(400).send("Room, name, and mobile number are required.");
    }
    if (!/^[6-9]\d{9}$/.test(mobileNo)) {
      return res.status(400).send("Invalid mobile number.");
    }

    const room = await Room.findById(assignedRoom_id);
    if (!room) return res.status(404).send("Room not found.");
    if (room.sharing_capacity <= room.occupied_beds) return res.status(400).send("This room is full. Please choose another room.");

    const newMember = new Member({
      user: userId, hostel: selectedHostel,
      assignedRoom_id, name: clean(name), fatherName: clean(fatherName || ""),
      mobileNo, aadharNo: clean(aadharNo || ""), address: clean(address || ""),
      profession: clean(profession || ""), joiningDate,
      assignedRoom: room.room_number, status: "Inactive"
    });

    const newPayment = new Payment({ memberId: newMember._id, roomId: assignedRoom_id, roomFees: room.room_fees });
    await newPayment.save();
    newMember.payments.push(newPayment._id);
    await newMember.save();

    await Room.findByIdAndUpdate(assignedRoom_id, { $inc: { occupied_beds: 1 } });
    await Floor.findByIdAndUpdate(room.floor_id, { $inc: { active_number: 1, occupied_beds: 1 } });

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
    const member = await Member.findById(req.params.id).populate('payments');
    if (!member) return res.status(404).send("Member not found.");

    const totalFees = (member.payments || []).reduce((s, p) => s + (p.roomFees   || 0), 0);
    const amtPaid   = (member.payments || []).reduce((s, p) => s + (p.amountPaid || 0), 0);
    const dueAmount = Math.max(0, totalFees - amtPaid);

    safeRender(res, "payments/addpayment.ejs", { member, dueAmount, user });
  } catch (err) {
    console.error("addpayment GET error:", err.message);
    res.status(500).send("Server Error.");
  }
});

router.post("/addpayment/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    const { id } = req.params;
    const p    = req.body.payment || {};

    const amountPaid  = toNum(p.amountPaid);
    const paymentMode = clean(p.paymentMode || "");
    const paymentDate = p.paymentDate;

    if (amountPaid <= 0) return res.status(400).send("Amount paid must be greater than 0.");
    if (!paymentMode)    return res.status(400).send("Payment mode is required.");

    const member = await Member.findById(id);
    if (!member) return res.status(404).send("Member not found.");

    const newPayment = new Payment({ memberId: id, amountPaid, paymentMode, paymentDate });
    const saved      = await newPayment.save();

    member.payments.push(saved._id);
    member.status   = "Active";
    member.leftDate = "";
    await member.save();

    res.redirect(`/user/payment-receipt/${saved._id}`);
  } catch (err) {
    console.error("addpayment POST error:", err.message);
    res.status(500).send("Internal Server Error. Please try again.");
  }
});

router.get("/payment-receipt/:paymentId", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user    = await Owner.findById(req.user.id);
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) return res.status(404).send("Payment not found.");

    const member = await Member.findById(payment.memberId);
    if (!member) return res.status(404).send("Member not found.");

    safeRender(res, "payments/paymentreciept.ejs", { member, payment, user });
  } catch (err) {
    console.error("payment-receipt error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

router.post("/member/search", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId      = req.user.id;
    const user        = await Owner.findById(userId);
    const searchQuery = clean(req.body.name || "");

    if (!searchQuery) return res.status(400).send("Search query is required.");

    const members = await Member.find({
      user: userId,
      $or: [
        { name:     { $regex: searchQuery, $options: "i" } },
        { mobileNo: searchQuery }
      ]
    }).populate('payments');

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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel }).populate("payments").sort({ createdAt: -1 });

    const membersWithFees = allMembers.map(m => {
      const totalFees   = (m.payments || []).reduce((s, p) => s + (p.roomFees   || 0), 0);
      const amountPaid  = (m.payments || []).reduce((s, p) => s + (p.amountPaid || 0), 0);
      const dueAmount   = Math.max(0, totalFees - amountPaid);
      const advancedPaid = Math.max(0, amountPaid - totalFees);
      return { ...m.toObject(), totalFees, advancedPaid, amountPaid, dueAmount };
    });

    safeRender(res, "payments/allrecords.ejs", { allMembers: membersWithFees, user });
  } catch (err) {
    console.error("allfeesrecords error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

router.post("/searchfeesrecords", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId      = req.user.id;
    const user        = await Owner.findById(userId);
    const searchQuery = clean(req.body.searchQuery || "");

    const filtered = await Member.find({
      user: userId,
      $or: [
        { name:     { $regex: searchQuery, $options: "i" } },
        { mobileNo: searchQuery }
      ]
    }).populate("payments");

    const membersWithFees = filtered.map(m => {
      const totalFees    = (m.payments || []).reduce((s, p) => s + (p.roomFees   || 0), 0);
      const amountPaid   = (m.payments || []).reduce((s, p) => s + (p.amountPaid || 0), 0);
      const dueAmount    = Math.max(0, totalFees - amountPaid);
      const advancedPaid = Math.max(0, amountPaid - totalFees);
      return { ...m.toObject(), totalFees, advancedPaid, amountPaid, dueAmount };
    });

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
    const member   = await Member.findById(req.params.memberId);
    if (!member) return res.status(404).send("Member not found.");
    const payments = await Payment.find({ memberId: req.params.memberId }).sort({ paymentDate: -1 });
    safeRender(res, 'payments/PaymentHistoryOfOne.ejs', { member, payments, user });
  } catch (err) {
    console.error("payment-history error:", err.message);
    res.status(500).send('Server Error.');
  }
});

router.get("/upcomingPayments", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const today       = new Date();
    const upcomingDays = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      return d.getDate();
    });

    const members = await Member.find({ user: userId, hostel: selectedHostel }).populate('payments');
    const upcoming = members.filter(m => upcomingDays.includes(new Date(m.joiningDate).getDate()));

    safeRender(res, "payments/upcomingPayments.ejs", { allMembers: upcoming, user });
  } catch (err) {
    console.error("upcomingPayments error:", err.message);
    res.status(500).send("Internal Server Error.");
  }
});

router.get("/deureports", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const userId         = req.user.id;
    const user           = await Owner.findById(userId);
    const selectedHostel = res.locals.selectedHostel?._id;
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel }).populate("payments");
    const membersWithFees = allMembers.map(m => {
      const totalFees    = (m.payments || []).reduce((s, p) => s + (p.roomFees   || 0), 0);
      const amountPaid   = (m.payments || []).reduce((s, p) => s + (p.amountPaid || 0), 0);
      const dueAmount    = Math.max(0, totalFees - amountPaid);
      const advancedPaid = Math.max(0, amountPaid - totalFees);
      return { ...m.toObject(), totalFees, advancedPaid, amountPaid, dueAmount };
    });
    safeRender(res, "payments/duesReport.ejs", { allMembers: membersWithFees, user });
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
    if (!selectedHostel) return res.send("⚠️ Please select a hostel first.");

    const fmt = n => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
    const empty = { totalExpectedRevenue: fmt(0), totalFeesCollected: fmt(0), totalPendingAmount: fmt(0), totalAdvancedPaid: fmt(0), balance: fmt(0), paidAccounts: 0, dueAccounts: 0, feesCollectionCompleted: 0, user };

    const allMembers = await Member.find({ user: userId, hostel: selectedHostel }).populate("payments");
    if (!allMembers.length) return safeRender(res, "payments/revenue", empty);

    let totalExpectedRevenue = 0, totalFeesCollected = 0,
        totalPendingAmount   = 0, totalAdvancedPaid   = 0,
        paidAccounts         = 0, dueAccounts         = 0;

    allMembers.forEach(m => {
      const fees = (m.payments || []).reduce((s, p) => s + (p.roomFees   || 0), 0);
      const paid = (m.payments || []).reduce((s, p) => s + (p.amountPaid || 0), 0);
      totalExpectedRevenue += fees;
      totalFeesCollected   += paid;
      totalPendingAmount   += Math.max(0, fees - paid);
      totalAdvancedPaid    += Math.max(0, paid - fees);
      paid >= fees ? paidAccounts++ : dueAccounts++;
    });

    const balance = totalExpectedRevenue - totalFeesCollected;
    const feesCollectionCompleted = totalExpectedRevenue > 0
      ? ((totalFeesCollected / totalExpectedRevenue) * 100).toFixed(2) : 0;

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
      amenities, rules, contact, status: "Approved"
    });
    await newListing.save();

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
      listing.rooms = Object.values(req.body.rooms || {}).map(r => ({
        type:      clean(r.type || ""),
        price:     toNum(r.price),
        deposit:   toNum(r.deposit),
        features:  (Array.isArray(r.features) ? r.features : r.features ? [r.features] : []).map(f => clean(f)),
        available: r.available === "true" || r.available === true
      })).filter(r => r.type).slice(0, 20);
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

    listing.status = "Approved";
    await listing.save();
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




