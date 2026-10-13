/* ============================================================
   utils/sendMail.js  —  the one way HostelNode sends email
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   Admin Console Phase 1:
   • The Gmail address and app password now come from .env
       MAIL_USER=hostelnodehelp@gmail.com
       MAIL_PASS=<Gmail app password>
     (they were written in this file before, so they were on GitHub —
     make a new app password in Google and put it in .env).
   • Every email is logged to hn_email_log for the admin console:
     purpose, address masked + hashed, subject, sent or not.

   sendMail(to, subject, html, { purpose?, attachments? }) → true | false
   Never throws.

   HN_MAIL_TEST_FILE (tests only): no email leaves the server; each one
   is appended to that file as a JSON line instead.
============================================================ */
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");

let transporter = null;
let warned = false;
// Say it loudly at start-up, not only at the first email.
if (!String(process.env.HN_MAIL_TEST_FILE || "").trim() && (!String(process.env.MAIL_USER || "").trim() || !String(process.env.MAIL_PASS || "").trim())) {
  warned = true;
  console.error("❌ MAIL_USER / MAIL_PASS are not set in .env — no email will be sent (OTP emails, password resets, receipts, reminders).");
}
function transport() {
  if (transporter) return transporter;
  const user = String(process.env.MAIL_USER || "").trim(), pass = String(process.env.MAIL_PASS || "").trim();
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  return transporter;
}

const PURPOSES = [[/otp|verification code|verify your/i, "otp"], [/password/i, "password"], [/login|sign[- ]?in|new device/i, "login_alert"], [/welcome/i, "welcome"],
  [/receipt/i, "receipt"], [/plan|subscription|renew|expir/i, "plan_reminder"], [/rent/i, "rent_reminder"], [/listing/i, "listing"], [/admin/i, "admin_alert"], [/booking/i, "booking"], [/kyc/i, "kyc"]];
function purposeOf(subject) { const hit = PURPOSES.find(([r]) => r.test(String(subject || ""))); return hit ? hit[1] : "other"; }
const { maskEmail, hashEmail } = require("./hnPii");

async function log(to, subject, purpose, ok, error) {
  try {
    let site = "";
    try { site = require("./activity").site(); } catch { site = ""; }
    const L = require("../models/hnEmailLog");
    const list = (Array.isArray(to) ? to : String(to || "").split(",")).map(s => String(s).trim()).filter(Boolean);
    const rows = list.map(addr => ({ at: new Date(), site, purpose, toMasked: maskEmail(addr), toHash: hashEmail(addr), subject: String(subject || "").slice(0, 200), ok, error: String(error || "").slice(0, 300) }));
    if (rows.length) await L.collection.insertMany(rows, { ordered: false });
  } catch (err) { console.error("Email log (non-fatal):", err.message); }
}

const sendMail = async (to, subject, html, opts = {}) => {
  const purpose = (opts && opts.purpose) || purposeOf(subject);
  if (!to || !subject) return false;
  // Tests only: write the email to a file instead of sending it.
  const testFile = String(process.env.HN_MAIL_TEST_FILE || "").trim();
  if (testFile) {
    const ok = !/fail/i.test(String(to));
    try { fs.appendFileSync(testFile, JSON.stringify({ to, subject, html, purpose, attachments: (opts.attachments || []).map(a => a.filename || ""), at: Date.now(), port: process.env.PORT }) + "\n"); } catch { /* ignore */ }
    log(to, subject, purpose, ok, ok ? "" : "test failure");
    return ok;
  }
  try {
    const t = transport();
    if (!t) {
      if (!warned) { warned = true; console.error("❌ Email not sent: set MAIL_USER and MAIL_PASS in .env"); }
      log(to, subject, purpose, false, "MAIL_USER / MAIL_PASS not set");
      return false;
    }
    const from = String(process.env.MAIL_FROM || "").trim() || `"HostelNode" <${String(process.env.MAIL_USER).trim()}>`;
    await t.sendMail({ from, to, subject, html, ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}) });
    console.log("✅ Email sent");
    log(to, subject, purpose, true, "");
    return true;
  } catch (err) {
    console.error("❌ Email error:", err.message);
    log(to, subject, purpose, false, err.message);
    return false;
  }
};

module.exports = { sendMail, purposeOf, maskEmail, hashEmail };
