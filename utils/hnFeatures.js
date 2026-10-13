/* ============================================================
   utils/hnFeatures.js  —  Admin Console Phase 1 (feature switches)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   The admin console can switch some features off (or back on) without
   editing .env. Every 30 seconds this reads hn_settings "features":
       { HN_BOOKINGS: "off", HN_REPORTS: "on", … }   (missing = as in .env)
   and sets those names in this process's environment, so the existing
   checks (bookings.switchedOn(), payments.ledgerOn(), …) see it with no
   other change. Only the names in ALLOWED can be changed this way;
   when a switch is cleared, the value from .env comes back.
============================================================ */
const ALLOWED = {
  // name: [value meaning off, value meaning on]
  HN_BOOKINGS:       ["off", "on"],   // book a bed online (both sites)
  HN_ONLINE_RENT:    ["off", "on"],   // tenants pay rent online (My PG)
  HN_PAYOUTS:        ["off", "on"],   // owner bank payouts (Receive payments)
  HN_LEDGER:         ["off", "on"],   // new rent ledger, Payments and Dues pages
  HN_REPORTS:        ["off", "on"],   // new Reports page
  HN_RENT_REMINDERS: ["off", "on"],   // automatic rent reminders
  HN_REMINDER_EMAIL: ["off", "on"],   // rent reminder emails
};
const EVERY_MS = Math.max(Number(process.env.HN_SETTINGS_CACHE_MS) || 30 * 1000, 500);   // env override is for tests only

const fromEnv = {};
for (const k of Object.keys(ALLOWED)) fromEnv[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
let applied = {};
let timer = null;
let reported = 0;

function apply(value) {
  const want = {};
  for (const [k, v] of Object.entries(value || {})) {
    if (!ALLOWED[k]) continue;
    const s = String(v).toLowerCase();
    if (s === "off") want[k] = ALLOWED[k][0];
    else if (s === "on") want[k] = ALLOWED[k][1];
  }
  for (const k of Object.keys(ALLOWED)) {
    if (want[k] !== undefined) process.env[k] = want[k];
    else if (applied[k] !== undefined) {   // cleared in the admin → back to .env
      if (fromEnv[k] === undefined) delete process.env[k]; else process.env[k] = fromEnv[k];
    }
  }
  applied = want;
}

async function refresh() {
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState !== 1) return;
    const col = mongoose.connection.collection("hn_settings");
    const doc = await col.findOne({ _id: "features" }, { maxTimeMS: 1500 });
    apply((doc && doc.value) || {});
    // Tell the admin console what this site's .env says (shown next to each switch), about once a minute.
    if (Date.now() - reported > 60 * 1000) {
      reported = Date.now();
      let site = "";
      try { site = require("./activity").site(); } catch { site = ""; }
      if (site) {
        const env = {};
        for (const k of Object.keys(ALLOWED)) env[k] = fromEnv[k] === undefined ? null : String(fromEnv[k]);
        // WhatsApp template names set in .env (names only, no secrets), so the admin can list them with their switches.
        const templates = [];
        try {
          const { categoryOf } = require("./waSend");
          for (const [k, v] of Object.entries(process.env)) {
            const name = String(v || "").trim();
            if (!k.startsWith("WA_TEMPLATE_") || k.endsWith("_LANG") || !name || /^(off|0|false)$/i.test(name)) continue;
            templates.push({ key: k, name: name.slice(0, 100), category: categoryOf(name) });
          }
        } catch { /* ignore */ }
        await col.updateOne({ _id: "env:" + site }, { $set: { value: { env, templates, pid: process.pid }, updatedAt: new Date() } }, { upsert: true });
      }
    }
  } catch (err) { console.error("Feature switches (non-fatal):", err.message); }
}

function start() {
  if (timer) return;
  const mongoose = require("mongoose");
  if (mongoose.connection.readyState === 1) refresh(); else mongoose.connection.once("connected", refresh);
  timer = setInterval(refresh, EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, refresh, apply, ALLOWED, fromEnv: () => ({ ...fromEnv }) };
