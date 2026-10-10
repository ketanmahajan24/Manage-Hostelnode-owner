/* ============================================================
   utils/rentReminders.js  —  Property Operations Phase 9

   Rent reminders to tenants, from HostelNode's WhatsApp number and by
   email, with the amount and (when the PG takes rent online) a
   "Pay now" button that opens My PG on hostelnode.com.

   Automatic (run() — app.js runs it at 10:00 and 15:00 India time):
     • "before": N days before the due day (default 3)
     • "due":    on the due day
     • "after":  N days after the due day, if still unpaid (default 3)
   The owner switches them off, changes the days, or turns them off for
   one property (Payments → Dues → Reminder settings).

   Never sent to a tenant who moved out, was removed, has nothing due
   (or, before the due day, whose advance covers the rent). Each
   automatic reminder is sent once (a claim per tenant + step + due
   day), and a tenant gets at most one reminder a day, automatic or by
   hand. A reminder that could not be delivered at all is not counted,
   so the 15:00 run tries it again.

   By hand (sendNow()): "Send reminder" on Dues (once a day per tenant).

   Emails go through utils/sendMail.js (one Gmail account, which has a
   daily limit): at most HN_REMINDER_EMAIL_MAX emails per run (default 200).

   WhatsApp needs approved templates (category Utility, language en):
     WA_TEMPLATE_RENT_DUE       with a "Pay now" URL button to My PG
                                (due day and after, when the PG takes rent online)
     WA_TEMPLATE_RENT_REMINDER  no button (before the due day, and cash-only PGs)
   Both: {{1}} first name, {{2}} amount, {{3}} PG name, {{4}} "is due on 10 Oct" / "is due today" /
   "was due on 7 Oct and is still unpaid".
   Email uses utils/sendMail.js (HN_REMINDER_EMAIL=off stops emails).
   HN_RENT_REMINDERS=off stops all reminders.
============================================================ */

const mongoose = require("mongoose");
const moment = require("moment-timezone");
const validator = require("validator");
const { TZ, LIVING, dueDateIn, dueAnchor, nextDueDate } = require("./tenantOps");
const L = require("./ledger");
const T = require("./tenants");
const { tenantRent } = require("./beds");

const DEFAULTS = { on: true, before: 3, onDay: true, after: 3, offHostels: [] };
const MAX_BEFORE = 10, MAX_AFTER = 15;
const emailMax = () => { const v = String(process.env.HN_REMINDER_EMAIL_MAX || "").trim(); const n = Number(v); return v !== "" && Number.isInteger(n) && n >= 0 ? n : 200; };
const isOid = v => !!v && mongoose.isValidObjectId(String(v)) && /^[0-9a-f]{24}$/i.test(String(v));
const delivered = r => !!(r && ((r.wa && r.wa.sent) || (r.email && r.email.sent)));
// A delivered reminder to this tenant since the start of `today` (India time)?
const SENT = [{ "wa.sent": true }, { "email.sent": true }];
const TPL = { due: "WA_TEMPLATE_RENT_DUE", reminder: "WA_TEMPLATE_RENT_REMINDER" };

const off = v => /^(off|0|false|no)$/i.test(String(v || "").trim());
const enabled = () => !off(process.env.HN_RENT_REMINDERS);
const emailOn = () => !off(process.env.HN_REMINDER_EMAIL);
const tpl = name => { const v = String(process.env[name] || "").trim(); return v && !off(v) ? v : ""; };
const waReady = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID;
const mainSite = () => String(process.env.HN_MAIN_SITE_URL || "https://hostelnode.com").trim().replace(/\/$/, "");
const payLink = () => mainSite() + "/student/my-pg";
const first = name => String(name || "").trim().split(/\s+/)[0] || "there";
const escHtml = s => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mobile10 = v => require("./onlineRent").mobile10(v);
const validEmail = v => { const s = String(v || "").trim(); return s.length <= 120 && validator.isEmail(s) ? s : ""; };

/** What can be sent at all: { wa: { due, reminder }, email, any } */
function channels() {
  const w = waReady();
  const out = { wa: { due: w && !!tpl(TPL.due), reminder: w && !!tpl(TPL.reminder) }, email: emailOn() };
  out.any = enabled() && (out.wa.due || out.wa.reminder || out.email);
  return out;
}

/* ── settings ─────────────────────────────────────────────── */
const days = (v, max, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= max ? n : dflt; };
function normal(s) {
  const d = Object.assign({}, DEFAULTS, s || {});
  return { on: d.on !== false, before: days(d.before, MAX_BEFORE, DEFAULTS.before), onDay: d.onDay !== false, after: days(d.after, MAX_AFTER, DEFAULTS.after), offHostels: (d.offHostels || []).map(String) };
}
async function settingsOf(ownerId) {
  const S = require("../models/reminderSettings");
  return normal(await S.findOne({ owner: ownerId }).lean());
}
/** Save from the settings form. hostels: this owner's properties (only those can be switched off). */
async function saveSettings(ownerId, body, hostels) {
  const S = require("../models/reminderSettings");
  const ids = hostels.map(h => String(h._id));
  const onIds = [].concat(body.hostelOn || []).map(String);
  const set = {
    on: body.on === "1",
    before: body.beforeOn === "1" ? days(body.before, MAX_BEFORE, DEFAULTS.before) || 1 : 0,
    onDay: body.onDay === "1",
    after: body.afterOn === "1" ? days(body.after, MAX_AFTER, DEFAULTS.after) || 1 : 0,
    offHostels: ids.filter(id => !onIds.includes(id)).map(id => new mongoose.Types.ObjectId(id)),
  };
  await S.updateOne({ owner: ownerId }, { $set: set, $setOnInsert: { owner: ownerId } }, { upsert: true });
  return normal(set);
}

/* ── what to send ─────────────────────────────────────────── */
const phraseOf = (step, dueOn) => step === "before" ? "is due on " + dueOn.format("D MMM")
  : step === "due" ? "is due today" : "was due on " + dueOn.format("D MMM") + " and is still unpaid";

/**
 * The automatic reminder a tenant should get today, or null.
 * m: tenant (payments populated); lg: L.ledgerOf(m); s: settings; today: moment (India, start of day); rent: their monthly rent.
 * At most one: after > due > before.
 */
function planFor(m, lg, s, today, rent) {
  if (!s.on || m.leftDate || m.removedAt) return null;
  const anchor = dueAnchor(m);
  if (!anchor || isNaN(new Date(anchor))) return null;
  const owes = lg.due > 0 && !lg.notYetDue;
  if (s.after > 0 && owes) {
    // The due day that was `after` days ago (or up to 2 days earlier, if a run was missed).
    for (let late = s.after; late <= s.after + 2; late++) {
      const day = today.clone().subtract(late, "days");
      if (!dueDateIn(anchor, day).isSame(day, "day")) continue;
      if (m.joiningDate && moment(m.joiningDate).tz(TZ).startOf("day").isAfter(day)) break;
      return { step: "after", dueOn: day, amount: lg.due };
    }
  }
  if (s.onDay && owes) {
    const d = dueDateIn(anchor, today);
    // (Not on the day they moved in: the first rent is collected at admission.)
    if (d.isSame(today, "day") && !(m.joiningDate && moment(m.joiningDate).tz(TZ).isSame(today, "day"))) return { step: "due", dueOn: d, amount: lg.due };
  }
  if (s.before > 0) {
    const d = nextDueDate(anchor, today.clone().add(1, "day").toDate());
    const ahead = d ? d.diff(today, "days") : 0;
    if (d && ahead >= 1 && ahead <= s.before) {
      const leaving = m.leavingDate && !moment(m.leavingDate).tz(TZ).startOf("day").isAfter(d);
      const charged = lg.months.some(mo => mo.key === d.format("YYYY-MM") && mo.charges.some(c => c.kind === "rent"));
      const amount = lg.due + (leaving || charged ? 0 : Math.max(0, Number(rent) || 0)) - lg.advance;
      if (amount > 0) return { step: "before", dueOn: d, amount };
    }
  }
  return null;
}

/* ── sending ──────────────────────────────────────────────── */
async function sendWa(name, phone, values) {
  try {
    const t = tpl(name);
    if (!t || !waReady()) return { sent: false, why: "off" };
    const mobile = mobile10(phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    const lang = String(process.env[name + "_LANG"] || "en").trim();
    const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || "-";
    const base = String(process.env.WA_API_BASE || "https://graph.facebook.com/v19.0").replace(/\/$/, "") + "/" + process.env.WA_PHONE_ID;
    const res = await fetch(base + "/messages", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + process.env.WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: "91" + mobile, type: "template",
        template: { name: t, language: { code: lang }, components: [{ type: "body", parameters: values.map(v => ({ type: "text", text: tidy(v) })) }] } }),
    });
    if (!res.ok) { let msg = ""; try { msg = (await res.json()).error.message; } catch { /* ignore */ } throw new Error(msg || "WhatsApp answered " + res.status); }
    return { sent: true, why: "" };
  } catch (err) {
    console.error("Rent reminder WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

/** The reminder email (subject, html). */
function emailOf({ name, property, amount, phrase, owing, online }) {
  const rows = (owing || []).slice(0, 6).map(o => `<tr><td style="padding:6px 0;color:#3d4f47">${escHtml(o.label)}</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#10231b">${escHtml(T.inr(o.amount))}</td></tr>`).join("");
  const subject = `Rent ${phrase.startsWith("was") ? "overdue" : "due"}: ${T.inr(amount)} · ${property || "your PG"}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:20px;color:#10231b">
  <h2 style="margin:0 0 12px;font-size:20px">Rent reminder</h2>
  <p style="font-size:15px;line-height:1.5;margin:0 0 14px">Hi ${escHtml(first(name))}, your rent of <b>${escHtml(T.inr(amount))}</b> for <b>${escHtml(property || "your PG")}</b> ${escHtml(phrase)}.</p>
  ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px">${rows}</table>` : ""}
  ${online ? `<p style="margin:0 0 16px"><a href="${escHtml(payLink())}" style="display:inline-block;padding:12px 22px;background:#0a7d4c;color:#fff;text-decoration:none;border-radius:10px;font-weight:bold">Pay now</a></p>
  <p style="font-size:13px;color:#6b7c75;margin:0 0 8px">Log in on hostelnode.com with this tenant's mobile number to pay from My PG, or pay your PG directly.</p>`
    : `<p style="font-size:14px;margin:0 0 8px">Please pay your PG directly.</p>`}
  <p style="font-size:12px;color:#6b7c75;margin:16px 0 0">Ignore this email if you have already paid. Sent by HostelNode for ${escHtml(property || "your PG")}.</p>
</div>`;
  return { subject, html };
}

/** Send one reminder now (WhatsApp and/or email). Returns { wa, email }. */
async function deliver({ m, property, amount, step, dueOn, online, lg, noEmail = false }) {
  const phrase = phraseOf(step, dueOn);
  const name = step !== "before" && online ? TPL.due : TPL.reminder;
  const wa = await sendWa(name, m.mobileNo, [first(m.name), T.inr(amount), property || "your PG", phrase]);
  let email = { sent: false, why: "off" };
  const to = validEmail(m.email);
  if (emailOn() && to && noEmail) email = { sent: false, why: "limit" };
  else if (emailOn() && to) {
    const owing = step === "before" ? [] : lg.owing;
    const e = emailOf({ name: m.name, property, amount, phrase, owing, online: online && step !== "before" });
    try { email = (await require("./sendMail").sendMail(to, e.subject, e.html)) ? { sent: true, why: "" } : { sent: false, why: "not sent" }; }
    catch (err) { console.error("Rent reminder email (non-fatal):", err.message); email = { sent: false, why: "not sent" }; }
  } else if (emailOn()) email = { sent: false, why: "no email" };
  return { wa, email };
}

/** Could anything reach this tenant? (a template for the step + a mobile, or an email address) */
function reachable(m, step, online) {
  const c = channels();
  if (!c.any) return false;
  const wa = (step !== "before" && online ? c.wa.due : c.wa.reminder) && !!mobile10(m.mobileNo);
  return wa || (c.email && !!validEmail(m.email));
}

/* ── claims (each automatic reminder once) ─────────────────── */
// A claim is "done" once its reminder was delivered. One left unfinished for 20 minutes (the server
// stopped while sending) is taken over by the next run, so a restart never loses a reminder.
// (Longer than the email connection's own 10-minute timeout. The stale claim is deleted and claimed
// again with insertOne, so the unique _id decides which server wins, as in utils/locks.js.)
const STALE_MS = 20 * 60 * 1000;
async function claim(key) {
  const col = mongoose.connection.collection("hn_reminder_keys");
  for (let i = 0; i < 2; i++) {
    try { await col.insertOne({ _id: key, at: new Date() }); return true; }
    catch (e) {
      if (!(e && e.code === 11000)) throw e;
      if (i) return false;
      const r = await col.deleteOne({ _id: key, done: { $ne: true }, at: { $lt: new Date(Date.now() - STALE_MS) } });
      if (!r || !r.deletedCount) return false;
    }
  }
  return false;
}
async function release(...keys) {
  for (const k of keys) await mongoose.connection.collection("hn_reminder_keys").deleteOne({ _id: k }).catch(() => {});
}
async function done(...keys) {
  await mongoose.connection.collection("hn_reminder_keys").updateMany({ _id: { $in: keys } }, { $set: { done: true } }).catch(() => {});
}

/** The automatic run. Never throws. Returns { checked, sent, skipped, errors }. */
async function run(now = new Date()) {
  const stats = { checked: 0, sent: 0, skipped: 0, errors: 0 };
  try {
    if (!enabled() || !channels().any) return stats;
    const Member = require("../models/member");
    const Hostel = require("../models/hostel");
    const Room = require("../models/room");
    const PayoutAccount = require("../models/payoutAccount");
    const RentReminder = require("../models/rentReminder");
    const S = require("../models/reminderSettings");
    const OR = require("./onlineRent");
    const today = moment(now).tz(TZ).startOf("day");
    const emailCap = emailMax();
    await mongoose.connection.collection("hn_reminder_keys").deleteMany({ at: { $lt: new Date(now.getTime() - 120 * 864e5) } }).catch(() => {});
    let emails = 0;
    // One owner at a time (never every tenant on HostelNode in memory at once).
    const owners = (await Member.distinct("user", { ...LIVING })).filter(isOid).map(String);
    for (const ownerId of owners) {
      try {
        const s = normal(await S.findOne({ owner: ownerId }).lean());
        if (!s.on) continue;
        const hostels = new Map((await Hostel.find({ owner: ownerId }, { hostelName: 1, onlineRent: 1, owner: 1, city: 1 }).lean()).map(h => [String(h._id), h]));
        const live = [...hostels.keys()].filter(id => !s.offHostels.includes(id));
        if (!live.length) continue;
        const members = await Member.find({ user: ownerId, hostel: { $in: live }, ...LIVING }).populate("payments");
        const rooms = new Map((await Room.find({ _id: { $in: members.map(m => m.assignedRoom_id).filter(isOid) } }, { room_fees: 1, beds: 1 }).lean()).map(r => [String(r._id), r]));
        const account = await PayoutAccount.findOne({ owner: ownerId }).lean();
        for (const m of members) {
          stats.checked++;
          try {
            const h = hostels.get(String(m.hostel));
            if (!h) { stats.skipped++; continue; }
            const lg = L.ledgerOf(m, now);
            const room = rooms.get(String(m.assignedRoom_id));
            const p = planFor(m, lg, s, today, room ? tenantRent(m, room) : 0);
            if (!p) { stats.skipped++; continue; }
            const online = (await OR.availability(m, { hostel: h, account })).can;
            if (!reachable(m, p.step, online)) { stats.skipped++; continue; }
            const key = `${m._id}:${p.step}:${p.dueOn.format("YYYY-MM-DD")}`;
            // Once per step and due day; at most one delivered reminder a day (also not after "Send reminder" today).
            if (await RentReminder.exists({ $or: [{ key }, { member: m._id, at: { $gte: today.toDate() }, $or: SENT }] })) { stats.skipped++; continue; }
            const dayKey = `day:${m._id}:${today.format("YYYY-MM-DD")}`;
            if (!(await claim(dayKey))) { stats.skipped++; continue; }
            if (!(await claim(key))) { await release(dayKey); stats.skipped++; continue; }
            const noEmail = emails >= emailCap;
            const r = await deliver({ m, property: h.hostelName, amount: p.amount, step: p.step, dueOn: p.dueOn, online, lg, noEmail });
            if (r.email.sent) emails++;
            if (delivered(r)) {
              await done(dayKey, key);
              await RentReminder.create({ key, owner: m.user, hostel: m.hostel, member: m._id, step: p.step, dueOn: p.dueOn.toDate(), amount: p.amount, wa: r.wa, email: r.email, by: "auto", at: new Date() });
              stats.sent++;
            } else {
              // Nothing reached the tenant: not counted, so the next run tries again.
              await release(dayKey, key);
              await RentReminder.create({ key: `failed:${key}:${Date.now()}`, owner: m.user, hostel: m.hostel, member: m._id, step: p.step, dueOn: p.dueOn.toDate(), amount: p.amount, wa: r.wa, email: r.email, by: "auto", at: new Date() });
              stats.skipped++;
            }
          } catch (err) {
            stats.errors++;
            console.error("Rent reminder (one tenant, non-fatal):", err.message);
          }
        }
      } catch (err) {
        stats.errors++;
        console.error("Rent reminders (one owner, non-fatal):", err.message);
      }
    }
  } catch (err) {
    stats.errors++;
    console.error("Rent reminders (non-fatal):", err.message);
  }
  return stats;
}

/**
 * "Send reminder" from Dues. m: the owner's tenant (payments populated).
 * Returns { ok, text } — text says what happened, for the page.
 */
async function sendNow({ ownerId, ownerName, m, now = new Date() }) {
  const RentReminder = require("../models/rentReminder");
  const Hostel = require("../models/hostel");
  const { withLocks } = require("./locks");
  if (!enabled()) return { ok: false, text: "Rent reminders are switched off." };
  if (m.leftDate || m.removedAt) return { ok: false, text: `${m.name} has moved out. Reminders go only to tenants living here.` };
  const lg = L.ledgerOf(m, now);
  if (!(lg.due > 0) || lg.notYetDue) return { ok: false, text: `${m.name} has nothing due right now.` };
  const h = await Hostel.findOne({ _id: m.hostel, owner: ownerId }, { hostelName: 1, onlineRent: 1, owner: 1, city: 1 }).lean();
  if (!h) return { ok: false, text: "That property was not found." };
  const online = (await require("./onlineRent").availability(m, { hostel: h })).can;
  const today = moment(now).tz(TZ).startOf("day");
  const step = lg.daysLate > 0 ? "after" : "due";
  const dueOn = lg.since ? moment(lg.since).tz(TZ).startOf("day") : today;
  if (!reachable(m, step, online)) {
    const c = channels();
    const waWhy = !(step !== "before" && online ? c.wa.due : c.wa.reminder) ? "WhatsApp reminders are not set up yet" : "there is no valid mobile number";
    return { ok: false, text: `${m.name} can't be reminded from HostelNode: ${waWhy}${c.email ? ", and there is no email address on their record" : ""}. Use 💬 Remind to send it from your own WhatsApp.` };
  }
  const already = t => ({ ok: false, text: `${m.name} was already reminded today at ${moment(t).tz(TZ).format("h:mm a")}. You can send another tomorrow, or use 💬 Remind.` });
  const r = await withLocks([`remind:${m._id}`], async () => {
    const last = await RentReminder.findOne({ member: m._id, at: { $gte: today.toDate() }, $or: SENT }).sort({ at: -1 }).lean();
    if (last) return already(last.at);
    // The same daily claim the automatic run takes, so the two never both send today.
    const dayKey = `day:${m._id}:${today.format("YYYY-MM-DD")}`;
    if (!(await claim(dayKey))) return { ok: false, text: `A reminder is being sent to ${m.name} right now. Check again in a few minutes.` };
    const d = await deliver({ m, property: h.hostelName, amount: lg.due, step, dueOn, online, lg });
    if (delivered(d)) await done(dayKey); else await release(dayKey);
    await RentReminder.create({ key: `manual:${m._id}:${Date.now()}`, owner: ownerId, hostel: m.hostel, member: m._id, step: "manual", dueOn: dueOn.toDate(), amount: lg.due, wa: d.wa, email: d.email, by: ownerName || "owner", at: new Date() });
    const how = [d.wa.sent ? "WhatsApp" : "", d.email.sent ? "email" : ""].filter(Boolean).join(" and ");
    return how ? { ok: true, text: `Reminder for ${T.inr(lg.due)} sent to ${m.name} on ${how}.` } : { ok: false, text: `The reminder to ${m.name} could not be sent. Please try again, or use 💬 Remind.` };
  });
  return r.busy ? { ok: false, text: "A reminder is being sent to this tenant right now." } : r.value;
}

/**
 * Which of these tenants "Send reminder" can reach now (living here, owes, a template + mobile or an email).
 * rows: [{ id, hostelId, mobile, email, out, daysLate }]. Returns a Set of ids.
 */
async function sendable(ownerId, rows) {
  const out = new Set();
  if (!enabled() || !channels().any || !rows.length) return out;
  const Hostel = require("../models/hostel");
  const PayoutAccount = require("../models/payoutAccount");
  const OR = require("./onlineRent");
  const account = await PayoutAccount.findOne({ owner: ownerId }).lean();
  const online = new Map();
  for (const r of rows) {
    if (r.out) continue;
    if (!online.has(r.hostelId)) {
      const h = await Hostel.findOne({ _id: r.hostelId, owner: ownerId }, { hostelName: 1, onlineRent: 1, owner: 1, city: 1 }).lean();
      online.set(r.hostelId, h ? (await OR.availability({ user: ownerId, hostel: h._id, leftDate: null }, { hostel: h, account })).can : null);
    }
    const on = online.get(r.hostelId);
    if (on === null) continue;
    if (reachable({ mobileNo: r.mobile, email: r.email }, r.daysLate > 0 ? "after" : "due", on)) out.add(r.id);
  }
  return out;
}

/** The latest reminder of each tenant: Map memberId → { at, by, step, sent } */
async function lastReminders(memberIds) {
  const RentReminder = require("../models/rentReminder");
  const out = new Map();
  if (!memberIds.length) return out;
  const since = new Date(Date.now() - 62 * 864e5);
  for (const r of await RentReminder.find({ member: { $in: memberIds }, at: { $gte: since } }).sort({ at: -1 }).lean()) {
    const k = String(r.member);
    if (!out.has(k)) out.set(k, { at: r.at, by: r.by, step: r.step, sent: !!((r.wa && r.wa.sent) || (r.email && r.email.sent)) });
  }
  return out;
}

/** "Today 10:00 · auto", "5 Oct · by you" */
function lastText(r, now = new Date()) {
  if (!r) return "";
  const at = moment(r.at).tz(TZ), today = moment(now).tz(TZ);
  const when = at.isSame(today, "day") ? "Today " + at.format("h:mm a") : at.isSame(today.clone().subtract(1, "day"), "day") ? "Yesterday " + at.format("h:mm a") : at.format("D MMM");
  return when + " · " + (r.by === "auto" ? "auto" : "by you") + (r.sent ? "" : " (not delivered)");
}

module.exports = { DEFAULTS, MAX_BEFORE, MAX_AFTER, TPL, enabled, emailOn, channels, settingsOf, saveSettings, normal, planFor, phraseOf, emailOf, deliver, reachable, run, sendNow, sendable, lastReminders, lastText, payLink };
