/* ============================================================
   utils/hnPii.js  —  Admin Console Phase 1
   SHARED: identical in hostelnode.com and manage.hostelnode.com
   (the admin console uses the same rules in lib/security.js).

   Logs never keep a full phone number or email:
   • masked for people to read:  98••••••10   ke•••@gmail.com
   • a keyed hash (HMAC-SHA256 with HN_PII_KEY) so the admin console
     can find one person's messages; without the key the hash can't be
     turned back into the number.
   HN_PII_KEY must be the same long random value in all three .env
   files (hostelnode.com, manage.hostelnode.com, admin.hostelnode.com).
============================================================ */
const crypto = require("crypto");

let warned = false;
if (!String(process.env.HN_PII_KEY || "").trim()) setImmediate(() => key());   // say it at start-up
function key() {
  const k = String(process.env.HN_PII_KEY || "").trim();
  if (!k && !warned) { warned = true; console.error("⚠️  HN_PII_KEY is not set: logs keep only masked numbers, and the admin console can't match messages to a person. Set the same value in all three .env files."); }
  return k;
}
// Without the key no hash is stored at all (a plain hash of a phone number could be reversed).
const h = v => { const k = key(); return k ? crypto.createHmac("sha256", k).update(v).digest("hex") : ""; };

/** The 10-digit Indian number ("" if it isn't one). */
const ten = v => { let d = String(v || "").replace(/\D/g, "").replace(/^00/, ""); if (d.length > 10 && d.startsWith("91")) d = d.slice(2); if (d.length > 10 && d.startsWith("0")) d = d.slice(1); return d.length === 10 ? d : ""; };
const maskPhone = v => { const t = ten(v); if (t) return t.slice(0, 2) + "••••••" + t.slice(8); const d = String(v || "").replace(/\D/g, ""); return d.length > 4 ? d.slice(0, 2) + "•••" + d.slice(-1) : ""; };
const maskEmail = v => { const s = String(v || "").trim().toLowerCase(); const i = s.indexOf("@"); return i > 0 ? s.slice(0, Math.min(2, i)) + "•••" + s.slice(i) : ""; };
const hashPhone = v => { const t = ten(v) || String(v || "").replace(/\D/g, ""); return t ? h("phone:" + t) : ""; };
const hashEmail = v => { const s = String(v || "").trim().toLowerCase(); return s ? h("email:" + s) : ""; };

module.exports = { ten, maskPhone, maskEmail, hashPhone, hashEmail };
