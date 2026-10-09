/* ============================================================
   utils/tenants.js  —  Property Operations Phase 3 (tenants and admissions)

   Shared helpers for the tenant list, tenant page and admission:
   • status of a tenant (Living, Moving out, Moved out)
   • money for one tenant (due, days late, this month paid or not)
   • history lines (who did what, when)
   • safe display (masked mobile and Aadhaar, initials)
   • the WhatsApp welcome message (only when its template is approved)
============================================================ */

const moment = require("moment-timezone");
const { TZ, money, dueDateIn, nextDueDate, dueAnchor } = require("./tenantOps");

const STATUS = {
  living: { key: "living", label: "Living",     cls: "is-ok" },
  notice: { key: "notice", label: "Moving out", cls: "is-warn" },
  out:    { key: "out",    label: "Moved out",  cls: "is-slate" },
};

function statusOf(m) {
  if (m.leftDate) return STATUS.out;
  if (m.leavingDate) return STATUS.notice;
  return STATUS.living;
}

const inr = n => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const day = d => (d && !isNaN(new Date(d)) ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TZ }) : "");
const dayYear = d => (d && !isNaN(new Date(d)) ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "");
// A date as YYYY-MM-DD in India time (for date inputs).
const ymd = d => (d && !isNaN(new Date(d)) ? moment(d).tz(TZ).format("YYYY-MM-DD") : "");
const ordinal = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// "98xxxxx210"
const maskMobile = v => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(0, 2) + "xxxxx" + d.slice(-3) : d; };
// "xxxx xxxx 4821"
const maskAadhaar = v => { const d = String(v || "").replace(/\s/g, ""); return d.length >= 4 ? "xxxx xxxx " + d.slice(-4) : ""; };
// Text safe to put inside a confirm message attribute (no line breaks or quotes).
const plain = s => String(s === null || s === undefined ? "" : s).replace(/[\r\n\u2028\u2029"<>]/g, " ").trim();
const initials = name => String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
// A steady colour per tenant (from their id), from the five page colours.
const TONES = ["green", "blue", "amber", "violet", "slate"];
const toneOf = id => TONES[parseInt(String(id || "0").slice(-2), 16) % TONES.length];

/** The day of the month rent is due (1–31), from the tenant's own due day or their joining day. */
function dueDayOf(m) {
  const d = Number(m.dueDay);
  if (Number.isInteger(d) && d >= 1 && d <= 31) return d;
  return m.joiningDate && !isNaN(new Date(m.joiningDate)) ? moment(m.joiningDate).tz(TZ).date() : null;
}

/**
 * Money for one tenant (payments populated): what they owe in total, since when
 * (oldest month not yet covered, charges paid oldest first), and this month's state.
 */
function moneyOf(m, now = new Date()) {
  const base = money(m);
  const pays = Array.isArray(m.payments) ? m.payments.filter(p => p && typeof p === "object") : [];
  const charges = pays.filter(p => Number(p.roomFees) > 0).sort((a, b) => new Date(a.paymentDate || 0) - new Date(b.paymentDate || 0));
  let paid = base.paid, since = null;
  for (const c of charges) { if (paid >= c.roomFees) { paid -= c.roomFees; continue; } since = c.paymentDate || null; break; }
  const today = moment(now).tz(TZ).startOf("day");
  const daysLate = base.due > 0 && since ? Math.max(0, today.diff(moment(since).tz(TZ).startOf("day"), "days")) : 0;
  const key = today.format("YYYY-MM");
  const chargedThisMonth = charges.some(c => c.chargeMonth === key || (!c.chargeMonth && moment(c.paymentDate).tz(TZ).format("YYYY-MM") === key));
  const next = m.leftDate ? null : nextDueDate(dueAnchor(m), now);
  // One short line for the list: "₹6,500 due", "Paid ✓", "Due 20 Oct".
  let state;
  if (base.due > 0) state = { tone: "bad", text: inr(base.due) + " due", sub: daysLate > 0 ? (daysLate === 1 ? "1 day late" : daysLate + " days late") : (base.paid > 0 && charges.length ? "part paid" : "due today") };
  else if (chargedThisMonth || m.leftDate) state = { tone: "ok", text: "Paid ✓", sub: base.advance > 0 ? inr(base.advance) + " in advance" : "" };
  else state = { tone: "soft", text: next ? "Due " + day(next.toDate()) : "Nothing due", sub: "" };
  return { ...base, since, daysLate, chargedThisMonth, next: next ? next.toDate() : null, state };
}

/**
 * Which rent months an admission charges (India time).
 * • Joined this month (or later): the first charge is the joining month, dated the joining day.
 * • Joined in an earlier month (an existing tenant being added): the first charge is the rent
 *   period running today; the months before it are listed in `earlier`, and the owner says
 *   whether they were already paid (nothing added) or should be added to dues.
 * The first charge covers `start` to the day before the next monthly charge (`days` days);
 * when the due day differs from the joining day that is not a full month, so a pro-rata
 * amount is suggested.
 */
function rentPlan({ joiningDate, dueDay, now = new Date() }) {
  const j = moment(joiningDate).tz(TZ).startOf("day"), today = moment(now).tz(TZ).startOf("day");
  const anchor = moment.tz([2000, 0, dueDay], TZ).toDate();
  const jm = j.clone().startOf("month");
  let pm = jm.clone();
  if (jm.isBefore(today.clone().startOf("month"))) {
    const thisDue = dueDateIn(anchor, today);
    pm = (today.isSameOrAfter(thisDue) ? today.clone() : today.clone().subtract(1, "month")).startOf("month");
    if (pm.isBefore(jm)) pm = jm.clone();
  }
  const dateOf = mm => (mm.isSame(jm, "month") ? j.clone() : dueDateIn(anchor, mm));
  const earlier = [];
  for (const mm = jm.clone(); mm.isBefore(pm) && earlier.length < 24; mm.add(1, "month")) earlier.push({ key: mm.format("YYYY-MM"), date: dateOf(mm).toDate(), label: mm.format("MMM YYYY") });
  // Joining on that month's rent day (e.g. the 30th with rent on the 31st in a 30-day month) is a full month.
  const joinsOnRentDay = j.isSame(dueDateIn(anchor, jm), "day");
  // The joining month, when it is one of the earlier months: from the joining day to the next rent day.
  const jNext = dueDateIn(anchor, jm.clone().add(1, "month"));
  const jDays = Math.max(1, jNext.diff(j, "days")), jFull = j.clone().add(1, "month").diff(j, "days");
  const joinAmount = rent => (joinsOnRentDay ? Number(rent) || 0 : Math.round((Number(rent) || 0) * jDays / jFull));
  const start = dateOf(pm);
  const next = dueDateIn(anchor, pm.clone().add(1, "month"));   // the monthly job charges the next month on its due day
  const days = Math.max(1, next.diff(start, "days"));
  const full = start.clone().add(1, "month").diff(start, "days");
  return {
    // What adding the earlier months to dues charges: the joining month pro-rata, the rest a full rent each.
    earlierAmounts: rent => earlier.map((e, i) => (i === 0 ? joinAmount(rent) : Number(rent) || 0)),
    first: { key: pm.format("YYYY-MM"), date: start.toDate(), label: pm.format("MMMM YYYY") },
    // A regular monthly charge, or a joining day equal to the due day, is a full month.
    earlier, start: start.toDate(), end: next.clone().subtract(1, "day").toDate(), days, fullMonth: !pm.isSame(jm, "month") || joinsOnRentDay || days === full,
    proRata: rent => Math.round((Number(rent) || 0) * days / full),
  };
}

/** Record one History line. Never throws (history must never stop the real change). */
async function logEvent(req, member, kind, text, note = "") {
  try {
    const TenantEvent = require("../models/tenantEvent");
    let byName = "";
    try { byName = (await require("../models/owner").findById(req.user.id, { name: 1 }).lean())?.name || ""; } catch { /* name is optional */ }
    await TenantEvent.create({
      owner: req.user.id, hostel: member.hostel, member: member._id, kind,
      text: String(text).slice(0, 300), note: String(note || "").slice(0, 300),
      by: { id: req.user.id, name: byName },
    });
  } catch (err) {
    console.error("Tenant history (non-fatal):", err.message);
  }
}

/**
 * History for one tenant, newest first: the saved lines plus every payment
 * (from the payment records). by: "you" when it was the logged-in owner.
 */
async function historyOf(member, viewerId, limit = 200) {
  const TenantEvent = require("../models/tenantEvent");
  const Payment = require("../models/payment");
  const [events, pays] = await Promise.all([
    TenantEvent.find({ member: member._id, owner: member.user }).sort({ at: -1 }).limit(limit).lean(),
    Payment.find({ _id: { $in: (member.payments || []).filter(Boolean).map(p => p._id || p) }, memberId: member._id, amountPaid: { $gt: 0 } }, { amountPaid: 1, paymentMode: 1, paymentDate: 1 }).sort({ paymentDate: -1 }).limit(limit).lean(),
  ]);
  const rows = events.map(e => ({
    at: e.at, kind: e.kind, text: e.text, note: e.note,
    by: e.by && e.by.id && String(e.by.id) === String(viewerId) ? "you" : (e.by && e.by.name) || "",
  })).concat(pays.map(p => ({
    at: p.paymentDate, kind: "payment", text: `Paid ${inr(p.amountPaid)}${p.paymentMode ? " · " + p.paymentMode : ""}`, note: "", by: "", paymentId: String(p._id),
  })));
  rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  return rows.slice(0, limit);
}

/* ── WhatsApp welcome to a new tenant ───────────────────────────
   Sent from HostelNode's WhatsApp number with an APPROVED template.
   Off until you set WA_TEMPLATE_TENANT_WELCOME to the approved
   template's name (see PROPERTY-OPERATIONS-PHASE-3.md for the text).
     Body: Hi {{1}}, welcome to {{2}}! Your room is {{3}}, bed {{4}}.
           Rent: {{5}} a month, due on the {{6}} of every month.
   Never throws. */
const welcomeTemplate = () => String(process.env.WA_TEMPLATE_TENANT_WELCOME || "").trim();
const welcomeLang = () => String(process.env.WA_TEMPLATE_TENANT_WELCOME_LANG || "en").trim();
const welcomeOn = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID && !!welcomeTemplate() && !/^(off|0|false)$/i.test(welcomeTemplate());

async function sendWelcome({ phone, name, property, room, bed, rent, dueDay }) {
  try {
    if (!welcomeOn()) return { sent: false, why: "off" };
    const { mobileOf } = require("./planReceiptWhatsapp");
    const mobile = mobileOf(phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || "-";
    const values = [name, property, room, bed, inr(rent), dueDay ? ordinal(dueDay) : "-"].map(tidy);
    const base = String(process.env.WA_API_BASE || "https://graph.facebook.com/v19.0").replace(/\/$/, "") + "/" + process.env.WA_PHONE_ID;
    const res = await fetch(base + "/messages", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + process.env.WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: "91" + mobile, type: "template",
        template: { name: welcomeTemplate(), language: { code: welcomeLang() }, components: [{ type: "body", parameters: values.map(v => ({ type: "text", text: v })) }] },
      }),
    });
    if (!res.ok) { let m = ""; try { m = (await res.json()).error.message; } catch { /* ignore */ } throw new Error(m || "WhatsApp answered " + res.status); }
    return { sent: true };
  } catch (err) {
    console.error("Tenant welcome WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

module.exports = {
  STATUS, statusOf, inr, day, dayYear, ymd, ordinal, maskMobile, maskAadhaar, plain, initials, toneOf, dueDayOf,
  moneyOf, rentPlan, logEvent, historyOf, sendWelcome, welcomeOn,
};
