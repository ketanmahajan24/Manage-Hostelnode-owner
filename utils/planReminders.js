/* ============================================================
   utils/planReminders.js  —  Subscriptions Phase 4 (owner dashboard)

   Emails owners before their plan or trial ends: 7, 3 and 1 days
   before, and once when it has ended. Run once a day from app.js.

   Only when "Remind owners before a plan ends" is on in admin.
   Each reminder is sent once per plan record, even if the app runs
   on several servers or the job runs twice.
============================================================ */

const Subscription    = require("../models/subscription");
const BillingSettings = require("../models/billingSettings");
const Owner           = require("../models/owner");
const { billingOn, DAY } = require("./subscription");

const SUPPORT_EMAIL = "hostelnodehelp@gmail.com";
const MAX_PER_RUN = 500;

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

async function mail(to, subject, html) {
  if (process.env.MAIL_USER && process.env.MAIL_PASS) {
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
    await t.sendMail({ from: `"HostelNode" <${process.env.MAIL_USER}>`, to, subject, html });
  } else {
    await require("./sendMail").sendMail(to, subject, html);
  }
}

// Link to the Plans page, if you set HN_OWNER_DASHBOARD_URL in .env.
function plansLink() {
  const base = String(process.env.HN_OWNER_DASHBOARD_URL || "").trim().replace(/\/$/, "");
  return /^https:\/\/[^\s"'<>]+$/.test(base) ? base + "/user/account/plans" : "";
}

// Whole calendar days in India from today to the end date (0 = ends today).
const IST = 5.5 * 60 * 60 * 1000;
const istDay = d => Math.floor((new Date(d).getTime() + IST) / DAY);
const calendarDaysLeft = (expiresAt, now) => istDay(expiresAt) - istDay(now);

// Which reminder is due for a plan ending at `expiresAt`? (null = none yet)
function dueKey(expiresAt, now) {
  if (new Date(expiresAt) <= now) return "expired";
  const d = calendarDaysLeft(expiresAt, now);
  if (d <= 1) return "1";
  if (d <= 3) return "3";
  if (d <= 7) return "7";
  return null;
}
// A later reminder also covers the earlier ones (no "7 days" mail after a "3 days" mail).
const COVERS = { "7": ["7"], "3": ["7", "3"], "1": ["7", "3", "1"], "expired": ["7", "3", "1", "expired"] };

function compose(sub, key, ownerName, now = new Date(), extra = {}) {
  const trial = sub.source === "trial" || (sub.snapshot && sub.snapshot.role === "trial");
  const what = trial ? "free trial" : `${sub.snapshot.name} plan`;
  const when = day(sub.expiresAt);
  const link = plansLink();
  const subject = key === "expired"
    ? `Your HostelNode ${what} has ended`
    : `Your HostelNode ${what} ends ${(d => (d <= 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days"))(calendarDaysLeft(sub.expiresAt, now))}`;
  const lead = key === "expired"
    ? `Your ${esc(what)} ended on <b>${esc(when)}</b>.`
    : `Your ${esc(what)} ends on <b>${esc(when)}</b>.`;
  const action = trial ? "Choose a plan" : "Renew your plan";
  // What the owner got from HostelNode in this period, when there is something to show.
  const n = Number(extra.leads) || 0;
  const period = trial ? "during your trial" : "on this plan";
  const got = n > 0
    ? `<p style="margin:0 0 14px;padding:11px 14px;background:#e3f6ec;border-radius:9px;color:#07603a;font-size:14px;line-height:1.5"><b>You received ${n} ${n === 1 ? "lead" : "leads"} ${period}</b> from hostelnode.com.</p>`
    : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;padding:24px;color:#12151a">
    <h2 style="margin:0 0 10px;color:#12151a">Hi ${esc(ownerName || "there")},</h2>
    <p style="margin:0 0 14px;color:#344054;font-size:15px;line-height:1.5">${lead}</p>
    ${got}
    <p style="margin:0 0 18px;color:#475467;font-size:14px;line-height:1.55">${action} to keep adding tenants and using every feature. Nothing is deleted when a plan ends: your tenants, payments and records stay safe.</p>
    ${link ? `<p style="margin:0 0 18px"><a href="${esc(link)}" style="display:inline-block;background:#0EA968;color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:9px">${action}</a></p>` : `<p style="margin:0 0 18px;color:#475467;font-size:14px">Open your HostelNode dashboard → Billing → View plans.</p>`}
    <p style="margin:0;color:#98a2b3;font-size:12px">Questions? Write to ${SUPPORT_EMAIL}.</p>
  </div>`;
  return { subject, html };
}

async function runReminders(now = new Date()) {
  const out = { checked: 0, sent: 0, skipped: 0 };
  if (!billingOn()) return out;
  const settings = await BillingSettings.read();
  if (!settings.remindersEnabled) return out;

  // Current plans ending within 7 days, or that ended in the last 2 days.
  const subs = await Subscription.find({
    status: "active", remindersSent: { $ne: "expired" },
    expiresAt: { $gt: new Date(now.getTime() - 2 * DAY), $lte: new Date(now.getTime() + 8 * DAY) },
  }).sort({ expiresAt: 1 }).limit(MAX_PER_RUN).lean();

  for (const sub of subs) {
    out.checked++;
    try {
      const key = dueKey(sub.expiresAt, now);
      if (!key || (sub.remindersSent || []).includes(key)) { out.skipped++; continue; }
      // Only the owner's newest current plan counts.
      const newest = await Subscription.findOne({ owner: sub.owner, status: "active" }).sort({ startsAt: -1, _id: -1 }).select("_id").lean();
      if (!newest || String(newest._id) !== String(sub._id)) { out.skipped++; continue; }

      // Leads received while this plan or trial was running (left out if it cannot be counted).
      // Counted before the reminder is claimed, so a slow count can never lose a reminder.
      let leads = 0;
      try {
        const until = sub.expiresAt && new Date(sub.expiresAt) < now ? sub.expiresAt : null;
        const st = await require("./leads").leadStats(sub.owner, { now, since: sub.startsAt, until });
        leads = st && st.sinceLeads ? st.sinceLeads : 0;
      } catch { leads = 0; }

      // Claim it first: whoever marks it sends it, nobody else does.
      const claim = await Subscription.updateOne(
        { _id: sub._id, status: "active", remindersSent: { $ne: key } },
        { $addToSet: { remindersSent: { $each: COVERS[key] } } }
      );
      if (!claim.modifiedCount) { out.skipped++; continue; }

      const owner = await Owner.findById(sub.owner).select("name email status").lean();
      if (!owner || !owner.email || owner.status === "Banned") { out.skipped++; continue; }
      const m = compose(sub, key, owner.name, now, { leads });
      try {
        await mail(owner.email, m.subject, m.html);
        out.sent++;
      } catch (err) {
        // Could not send: un-mark it so tomorrow's run tries again.
        console.error("Plan reminder mail (non-fatal):", err.message);
        await Subscription.updateOne({ _id: sub._id }, { $pull: { remindersSent: key } }).catch(() => {});
      }
    } catch (err) {
      console.error("Plan reminder (non-fatal):", err.message);
    }
  }
  return out;
}

module.exports = { runReminders, dueKey, compose };
