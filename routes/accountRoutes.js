/* ============================================================
   routes/accountRoutes.js  —  Redesign Phase 4: account pages
   Mounted at /user in app.js:
     GET  /user/account/settings               Settings
     POST /user/account/settings/password      change password
     POST /user/account/settings/alerts        login-alert emails on/off
     GET  /user/account/billing                Billing (read-only)
     GET  /user/account/kyc                    KYC status / form
     POST /user/account/kyc                    submit KYC document
     GET  /user/account/kyc/document           the owner's own KYC file
     GET  /user/notifications                  notifications list
     POST /user/notifications/read-all         mark all read
     POST /user/notifications/:id/open         mark one read, then open it
   Every route acts only on the logged-in owner's own record.
============================================================ */

const express  = require("express");
const router   = express.Router();
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");
const multer   = require("multer");
const bcrypt   = require("bcrypt");
const validator = require("validator");
const mongoose = require("mongoose");

const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner        = require("../models/owner");
const Notification = require("../models/Notification");

/* ── Mail: same account the rest of the app uses. MAIL_USER/MAIL_PASS in
      .env win if set; otherwise the project's existing utils/sendMail.js. ── */
async function mail(to, subject, html) {
  try {
    if (process.env.MAIL_USER && process.env.MAIL_PASS) {
      const nodemailer = require("nodemailer");
      const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
      await t.sendMail({ from: `"HostelNode" <${process.env.MAIL_USER}>`, to, subject, html });
    } else {
      await require("../utils/sendMail").sendMail(to, subject, html);
    }
  } catch (err) {
    console.error("Account mail (non-fatal):", err.message);
  }
}

const esc = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── Short messages shown after a redirect (?msg=…) ── */
const MESSAGES = {
  pw_ok:        ["ok",  "Password changed."],
  pw_wrong:     ["bad", "Your current password is not correct."],
  pw_mismatch:  ["bad", "The new passwords don't match."],
  pw_weak:      ["bad", "Use at least 6 characters, with an uppercase letter, a lowercase letter, a number and a symbol."],
  pw_same:      ["bad", "The new password must be different from the current one."],
  alerts_on:    ["ok",  "Login alert emails are on."],
  alerts_off:   ["ok",  "Login alert emails are off."],
  kyc_ok:       ["ok",  "Document submitted. We'll review it and update the status here."],
  kyc_type:     ["bad", "Choose a document type."],
  kyc_number:   ["bad", "That document number doesn't look right for the type you chose."],
  kyc_file:     ["bad", "Attach a clear photo or PDF of the document (JPG, PNG, WEBP or PDF, up to 5 MB)."],
  kyc_locked:   ["bad", "Your KYC is already submitted."],
  notif_read:   ["ok",  "All notifications marked as read."],
  error:        ["bad", "Something went wrong. Please try again."],
};
const has = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
const notice = code => (has(MESSAGES, code) ? { kind: MESSAGES[code][0], text: MESSAGES[code][1] } : null);

async function loadOwner(req, res) {
  const user = await Owner.findById(req.user.id);
  if (!user) { res.redirect("/login"); return null; }
  return user;
}

/* ════════════════ SETTINGS ════════════════ */

router.get("/account/settings", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await loadOwner(req, res); if (!user) return;
    res.render("account/settings.ejs", { user, notice: notice(req.query.msg) });
  } catch (err) {
    console.error("Settings page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/account/settings/password", jwtAuthMiddleware, async (req, res) => {
  const go = code => res.redirect("/user/account/settings?msg=" + code + "#password");
  try {
    const user = await Owner.findById(req.user.id);
    if (!user) return res.redirect("/login");
    const current = String(req.body.currentPassword || "");
    const next    = String(req.body.newPassword || "");
    const confirm = String(req.body.confirmPassword || "");

    if (!(await bcrypt.compare(current, user.password))) return go("pw_wrong");
    if (next !== confirm) return go("pw_mismatch");
    // Same rule as the existing reset-password page.
    if (!validator.isStrongPassword(next, { minLength: 6, minNumbers: 1 })) return go("pw_weak");
    if (await bcrypt.compare(next, user.password)) return go("pw_same");

    // Only the password field is written.
    await Owner.updateOne({ _id: user._id }, { $set: { password: await bcrypt.hash(next, 10) } });

    mail(user.email, "✅ Password Changed - HostelNode",
      `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#09B850;">Password Updated ✅</h2>
        <p>Hello ${esc(user.name)}, your password was changed from your account settings.</p>
        <p style="color:red;"><b>If this wasn't you, reset your password immediately.</b></p>
      </div>`);
    go("pw_ok");
  } catch (err) {
    console.error("Password change error:", err.message);
    go("error");
  }
});

router.post("/account/settings/alerts", jwtAuthMiddleware, async (req, res) => {
  try {
    const on = req.body.loginAlerts === "on";
    await Owner.updateOne({ _id: req.user.id }, { $set: { loginAlerts: on } }, { runValidators: true });
    res.redirect("/user/account/settings?msg=" + (on ? "alerts_on" : "alerts_off") + "#alerts");
  } catch (err) {
    console.error("Alerts setting error:", err.message);
    res.redirect("/user/account/settings?msg=error");
  }
});

/* ════════════════ BILLING (read-only) ════════════════ */

router.get("/account/billing", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await loadOwner(req, res); if (!user) return;
    const history = (user.billingHistory || [])
      .map(b => ({ amount: Number(b.amount) || 0, date: b.date, description: b.description || "", paid: !!b.paid }))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    // Subscriptions Phase 2: the owner's current plan (null when switched off or on any error).
    const plan = await require("../utils/planView").loadPlanInfo(user._id);
    // Subscriptions Phase 3: the owner's online plan payments, for receipt links (empty on any error).
    let receipts = [];
    try {
      if (plan) {
        const rows = await require("../models/subscriptionPayment")
          .find({ owner: user._id, status: { $in: ["paid", "refunded"] } }).sort({ paidAt: -1 }).limit(12).maxTimeMS(2000).lean();
        receipts = rows.map(r => ({ id: String(r._id), date: r.paidAt, name: (r.snapshot && r.snapshot.name) || "Plan", amount: r.amount, refunded: r.status === "refunded", hasReceipt: r.status === "paid" && !!r.subscription }));
      }
    } catch (e) { console.error("Billing receipts (non-fatal):", e.message); }
    res.render("account/billing.ejs", { user, history, plan, receipts });
  } catch (err) {
    console.error("Billing page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/* ════════════════ KYC ════════════════ */

const KYC_DIR = "/secure_uploads/kyc";   // same private area as other uploads
function ensureKycDir() {
  try { if (!fs.existsSync(KYC_DIR)) fs.mkdirSync(KYC_DIR, { recursive: true }); }
  catch (e) { console.error("Could not create KYC dir:", e.message); }
}
ensureKycDir();

const KYC_TYPES = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf",
};
const kycUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { ensureKycDir(); cb(null, KYC_DIR); },
    // Random name; extension from the checked file type, never from the upload's name.
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + KYC_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(KYC_TYPES, file.mimetype)),
});

// Document number rules; only the last 4 characters are ever stored.
const DOC_RULES = {
  "Aadhaar":         v => /^\d{12}$/.test(v),
  "PAN":             v => /^[A-Z]{5}\d{4}[A-Z]$/.test(v),
  "Driving licence": v => /^[A-Z0-9]{8,20}$/.test(v),
  "Passport":        v => /^[A-Z]\d{7}$/.test(v),
};
const mask = v => "•".repeat(Math.max(0, v.length - 4)) + v.slice(-4);

function removeUpload(req) {
  if (req.file?.path) fs.unlink(req.file.path, () => {});
}

// The browser's declared type isn't trusted: check the file's first bytes.
function looksLike(file) {
  try {
    const fd = fs.openSync(file.path, "r");
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    switch (file.mimetype) {
      case "image/jpeg":      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
      case "image/png":       return b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "image/webp":      return b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP";
      case "application/pdf": return b.slice(0, 4).toString() === "%PDF";
      default:                return false;
    }
  } catch {
    return false;
  }
}

router.get("/account/kyc", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await loadOwner(req, res); if (!user) return;
    res.render("account/kyc.ejs", { user, kyc: user.kyc || { status: "Not submitted" }, types: Object.keys(DOC_RULES), notice: notice(req.query.msg) });
  } catch (err) {
    console.error("KYC page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/account/kyc", jwtAuthMiddleware, (req, res, next) => {
  kycUpload.single("document")(req, res, err => {
    if (err) { removeUpload(req); return res.redirect("/user/account/kyc?msg=kyc_file"); }
    next();
  });
}, async (req, res) => {
  const go = code => res.redirect("/user/account/kyc?msg=" + code);
  try {
    const user = await Owner.findById(req.user.id);
    if (!user) { removeUpload(req); return res.redirect("/login"); }

    const status = user.kyc?.status || "Not submitted";
    if (status === "Pending" || status === "Verified") { removeUpload(req); return go("kyc_locked"); }

    const docType = String(req.body.docType || "");
    const number  = String(req.body.docNumber || "").replace(/[\s-]/g, "").toUpperCase();
    if (!has(DOC_RULES, docType))    { removeUpload(req); return go("kyc_type"); }
    if (!DOC_RULES[docType](number)) { removeUpload(req); return go("kyc_number"); }
    if (!req.file)                   return go("kyc_file");
    if (!looksLike(req.file))        { removeUpload(req); return go("kyc_file"); }

    const previousFile = user.kyc?.docFile;
    // The status condition in the filter stops two submissions racing each other.
    const result = await Owner.updateOne(
      { _id: user._id, "kyc.status": { $nin: ["Pending", "Verified"] } },
      { $set: {
        "kyc.status": "Pending",
        "kyc.docType": docType,
        "kyc.docNumberMasked": mask(number),
        "kyc.docFile": req.file.filename,
        "kyc.submittedAt": new Date(),
        "kyc.reviewedAt": null,
        "kyc.rejectionReason": "",
      } },
      { runValidators: true }
    );
    if (!result.modifiedCount) { removeUpload(req); return go("kyc_locked"); }

    // A resubmission replaces the earlier (rejected) document: don't keep old ID copies.
    if (previousFile && previousFile !== req.file.filename) {
      fs.unlink(path.join(KYC_DIR, path.basename(previousFile)), () => {});
    }
    go("kyc_ok");
  } catch (err) {
    console.error("KYC submit error:", err.message);
    removeUpload(req);
    go("error");
  }
});

router.get("/account/kyc/document", jwtAuthMiddleware, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id, { "kyc.docFile": 1 }).lean();
    const name = user?.kyc?.docFile ? path.basename(user.kyc.docFile) : "";
    const file = name ? path.join(KYC_DIR, name) : "";
    if (!file || !fs.existsSync(file)) return res.status(404).send("No document on file.");
    res.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
    res.sendFile(file);
  } catch (err) {
    console.error("KYC document error:", err.message);
    res.status(500).send("Could not open the document.");
  }
});

/* ════════════════ NOTIFICATIONS ════════════════ */

const PER_PAGE = 30;
const moment = require("moment-timezone");
function timeAgo(d) {
  if (!d) return "";
  const m = moment(d).tz("Asia/Kolkata"), n = moment().tz("Asia/Kolkata");
  const mins = n.diff(m, "minutes");
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  if (m.isSame(n, "day")) return n.diff(m, "hours") + "h ago";
  if (m.isSame(n.clone().subtract(1, "day"), "day")) return "yesterday";
  return m.format("D MMM, h:mm a");
}
const ownerFilter = id => ({ user: id, userModel: "Owner" });

router.get("/notifications", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await loadOwner(req, res); if (!user) return;
    const filter = ownerFilter(user._id);
    const total = await Notification.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const items = (await Notification.find(filter)
      .sort({ createdAt: -1 }).skip((page - 1) * PER_PAGE).limit(PER_PAGE).lean())
      .map(n => ({ ...n, when: timeAgo(n.createdAt) }));
    const unread = await Notification.countDocuments({ ...filter, isRead: false });
    res.render("account/notifications.ejs", { user, items, page, pages, total, unread, notice: notice(req.query.msg) });
  } catch (err) {
    console.error("Notifications page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/notifications/read-all", jwtAuthMiddleware, async (req, res) => {
  try {
    await Notification.updateMany({ ...ownerFilter(req.user.id), isRead: false }, { $set: { isRead: true, readAt: new Date() } });
    res.redirect("/user/notifications?msg=notif_read");
  } catch (err) {
    console.error("Mark-all-read error:", err.message);
    res.redirect("/user/notifications?msg=error");
  }
});

router.post("/notifications/:id/open", jwtAuthMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) return res.redirect("/user/notifications");
    const n = await Notification.findOneAndUpdate(
      { _id: id, ...ownerFilter(req.user.id) },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true }
    ).lean();
    // Only follow links inside this app's owner area.
    const link = n && typeof n.link === "string" && /^\/user\/[^/\\]/.test(n.link) && !/[\r\n]/.test(n.link) ? n.link : "/user/notifications";
    res.redirect(link);
  } catch (err) {
    console.error("Open notification error:", err.message);
    res.redirect("/user/notifications");
  }
});

module.exports = router;
