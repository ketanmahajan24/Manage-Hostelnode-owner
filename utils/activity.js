/* ============================================================
   utils/activity.js  —  Admin Console Phase 1 (tracking)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   Records what people do, for the admin console:
   • middleware(site)   every page opened, every login / logout /
                        failed login / OTP, every owner or student
                        action (a form sent), with who, where (city
                        from the IP, or GPS when the person allowed
                        it), device and time taken.
   • routes()           /hn/track.js   the small browser script (heartbeat
                                       while a page stays open, the
                                       "Allow location" card)
                        /hn/ping        heartbeat  → who is online now
                        /hn/loc         GPS position, only after "Allow"
   • record(ev)         for other modules (searches).

   Rules that keep the numbers exact:
   • written on the server, never guessed; no sampling;
   • search engines and scripts are flagged bot:true and kept out of
     visitor numbers; the HostelNode team, test accounts and office
     IPs are flagged internal:true;
   • a page reloaded within 10 seconds counts once;
   • events are written in the background (batched every second); a
     tracking problem is logged and never reaches the person.
   HN_TRACKING=off in .env (or the switch in the admin) stops it all.
============================================================ */

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");

let geoip = null, UAParser = null, mmdb = null;
try { geoip = require("geoip-lite"); } catch { geoip = null; }
try { UAParser = require("ua-parser-js"); } catch { UAParser = null; }
// GEOIP_DB_PATH (optional): MaxMind's GeoLite2-City.mmdb, kept fresh by geoipupdate.
// Used when the file and the "maxmind" package are present; otherwise geoip-lite's built-in copy.
(function openMaxmind() {
  try {
    const file = String(process.env.GEOIP_DB_PATH || "").trim();
    if (!file || !require("fs").existsSync(file)) return;
    const maxmind = require("maxmind");
    maxmind.open(file).then(r => { mmdb = r; console.log("IP city: MaxMind", file); }).catch(err => console.error("GeoIP (non-fatal):", err.message));
  } catch (err) { console.error("GeoIP (non-fatal):", err.message); }
})();

let SITE = "";
const FLUSH_MS = Number(process.env.HN_TRACK_FLUSH_MS) || 1000;   // env override is for tests only
const offEnv = () => /^(off|0|false|no)$/i.test(String(process.env.HN_TRACKING || "").trim());
const settings = () => require("./hnSettings");
function trackingOn() {
  if (offEnv()) return false;
  const S = settings();
  const t = S.peek("tracking");
  S.get("tracking").catch(() => {});   // refreshes the cached switch in the background (at most every 30 s)
  return !(t && t.on === false);
}

/* ── writing (batched) ─────────────────────────────────────── */
const queue = [];
let timer = null;
function flush() {
  timer = null;
  if (!queue.length) return;
  const rows = queue.splice(0, queue.length);
  try {
    const A = require("../models/hnActivity");
    A.collection.insertMany(rows, { ordered: false }).catch(err => console.error("Activity log (non-fatal):", err.message));
  } catch (err) { console.error("Activity log (non-fatal):", err.message); }
}
function push(row) {
  row.logAt = new Date();   // when it was written (the live feed follows this; "at" is when the request started)
  queue.push(row);
  if (queue.length >= 50) flush();
  else if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
}

/* ── who, where, what device ──────────────────────────────── */
// The visitor's IP. Behind nginx the last X-Forwarded-For entry is the one nginx
// itself added (earlier entries can be typed by anyone). Behind Cloudflare set
// HN_TRUST_CF=on so its CF-Connecting-IP header is used.
function ipOf(req) {
  const h = req.headers || {};
  let ip = "";
  if (/^(on|1|true|yes)$/i.test(String(process.env.HN_TRUST_CF || "").trim())) ip = String(h["cf-connecting-ip"] || "").trim();
  if (!ip && h["x-forwarded-for"]) { const parts = String(h["x-forwarded-for"]).split(",").map(s => s.trim()).filter(Boolean); ip = parts[parts.length - 1] || ""; }
  if (!ip) ip = String(h["x-real-ip"] || "").trim();
  if (!ip) ip = (req.socket && req.socket.remoteAddress) || req.ip || "";
  return String(ip).replace(/^::ffff:/, "").slice(0, 64);
}
const IN_STATES = { AN: "Andaman and Nicobar", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar", CH: "Chandigarh", CT: "Chhattisgarh", CG: "Chhattisgarh", DL: "Delhi", DN: "Dadra and Nagar Haveli", DH: "Dadra and Nagar Haveli and Daman and Diu", DD: "Daman and Diu", GA: "Goa", GJ: "Gujarat", HR: "Haryana", HP: "Himachal Pradesh", JK: "Jammu and Kashmir", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala", LA: "Ladakh", LD: "Lakshadweep", MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya", MZ: "Mizoram", NL: "Nagaland", OR: "Odisha", OD: "Odisha", PB: "Punjab", PY: "Puducherry", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TG: "Telangana", TS: "Telangana", TR: "Tripura", UP: "Uttar Pradesh", UT: "Uttarakhand", UK: "Uttarakhand", WB: "West Bengal" };
const geoCache = new Map();
function geoOf(ip) {
  if (!ip || (!geoip && !mmdb)) return { src: "", city: "", region: "", country: "" };
  if (geoCache.has(ip)) return geoCache.get(ip);
  let g = { src: "", city: "", region: "", country: "" };
  if (mmdb) {
    try {
      const r = mmdb.get(ip);
      if (r) {
        const sub = r.subdivisions && r.subdivisions[0];
        g = { src: "ip", city: (r.city && r.city.names && r.city.names.en) || "", region: (sub && sub.names && sub.names.en) || "", country: (r.country && r.country.iso_code) || "",
          lat: r.location ? r.location.latitude : null, lng: r.location ? r.location.longitude : null };
      }
    } catch { /* fall back below */ }
    if (g.src) { geoCache.set(ip, g); return g; }
  }
  try {
    const r = geoip ? geoip.lookup(ip) : null;
    if (r) g = { src: "ip", city: r.city || "", region: (r.country === "IN" && IN_STATES[r.region]) || r.region || "", country: r.country || "", lat: r.ll ? r.ll[0] : null, lng: r.ll ? r.ll[1] : null };
  } catch { /* unknown */ }
  if (geoCache.size > 5000) geoCache.clear();
  geoCache.set(ip, g);
  return g;
}
const BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|preview|curl|wget|python|axios|node-fetch|go-http|java\/|okhttp|httpclient|headless|phantom|lighthouse|pingdom|uptime|monitor|statuscake|ahrefs|semrush|mj12|dotbot|petalbot|yandex|baidu/i;
function uaOf(s) {
  const ua = String(s || "").slice(0, 400);
  let out = { browser: "", os: "", device: "desktop" };
  try {
    if (UAParser) {
      const r = new UAParser(ua).getResult();
      out = { browser: [r.browser && r.browser.name, r.browser && r.browser.major].filter(Boolean).join(" "), os: [r.os && r.os.name, r.os && r.os.version].filter(Boolean).join(" "), device: r.device && r.device.type === "mobile" ? "mobile" : r.device && r.device.type === "tablet" ? "tablet" : "desktop" };
    }
  } catch { /* keep defaults */ }
  return { ua: out, bot: !ua || BOT.test(ua) };
}
function verify(tok) { try { return tok ? jwt.verify(tok, process.env.JWT_SECRET) : null; } catch { return null; } }
const isId = v => /^[0-9a-f]{24}$/i.test(String(v || ""));
/** The person behind a request: owner | student | admin | guest. */
function actorOf(req) {
  const c = req.cookies || {};
  const path = String(req.path || req.url || "");
  const owner = () => { const d = verify(c.token); return d && isId(d.id) ? { kind: "owner", id: String(d.id), name: "" } : null; };
  const student = () => { const d = verify(c.studentToken); return d && isId(d.id) ? { kind: "student", id: String(d.id), name: "" } : null; };
  if (SITE === "main") {
    if (/^\/admin\b/.test(path)) { const d = verify(c.adminToken); if (d && isId(d.id)) return { kind: "admin", id: String(d.id), name: "" }; }
    const a = /^\/user\b/.test(path) ? (owner() || student()) : (student() || owner());
    if (a) return a;
  } else {
    const a = owner();
    if (a) return a;
  }
  return { kind: "guest", id: null, name: "" };
}
function refOf(req) {
  try { const r = String(req.headers.referer || req.headers.referrer || ""); if (!r) return ""; const u = new URL(r); return u.host === req.headers.host ? "" : u.host.slice(0, 120); } catch { return ""; }
}
async function internalOf(req, ip, actor) {
  try {
    const envIps = String(process.env.HN_INTERNAL_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (envIps.includes(ip)) return true;
    if (actor.kind === "admin") return true;
    if (SITE === "main" && req.cookies && req.cookies.adminToken && verify(req.cookies.adminToken)) return true;
    const t = await settings().tracking();
    if (t.internalIps.has(ip)) return true;
    if (actor.id && t.testIds.has(String(actor.id))) return true;
    return false;
  } catch { return false; }
}

/* ── names for pages and actions ──────────────────────────── */
const rx = p => new RegExp("^" + p.replace(/\//g, "\\/").replace(/:[a-zA-Z]+(\([^)]*\))?/g, m => (m.includes("(") ? m.slice(m.indexOf("(")) : "[^/]+")) + "\\/?$", "i");   // Express paths are not case-sensitive
const PAGES = {
  main: [["/", "Home"], ["/findHostels", "Find PGs"], ["/findHostels/results", "Search results"], ["/hostel/:slug", "Listing"], ["/findHostels/hostel/:id", "Listing"],
    ["/student", "Student profile"], ["/student/login", "Student login"], ["/student/signup", "Student sign-up"], ["/student/my-pg", "My PG"], ["/student/my-pg/pay", "My PG · pay rent"], ["/student/my-pg/paid/:id", "My PG · paid"],
    ["/student/bookings", "My bookings"], ["/student/bookings/:id", "Booking"], ["/student/book/:id", "Book a bed"], ["/student/wishlist", "Wishlist"], ["/student/saved", "Saved"], ["/student/recently-viewed", "Recently viewed"],
    ["/messages", "Messages"], ["/messages/:id", "Conversation"], ["/flatmate", "Flatmate"], ["/flatmate/:a", "Flatmate"], ["/flatmate/:a/:b", "Flatmate"], ["/kyc/return", "KYC · back from DigiLocker"],
    ["/login", "Owner login"], ["/signup", "Owner sign-up"], ["/about", "About"], ["/contact", "Contact"]],
  owner: [["/user", "Dashboard"], ["/user/members", "Tenants"], ["/user/newmember", "Add tenant"], ["/user/tenants/:id", "Tenant"], ["/user/tenants/:id/collect", "Collect payment"],
    ["/user/payments", "Payments"], ["/user/payments/upcoming", "Payments · upcoming"], ["/user/dues", "Dues"], ["/user/dues/reminders", "Reminder settings"], ["/user/bookings", "Bookings"],
    ["/user/allrooms", "Rooms"], ["/user/floors", "Floors"], ["/user/newroom", "Add room"], ["/user/revenue", "Reports"], ["/user/my-listings", "My listings"], ["/user/list-property", "List a property"],
    ["/user/leads", "Leads"], ["/user/messages", "Messages"], ["/user/messages/:id", "Conversation"], ["/user/notifications", "Notifications"], ["/user/account/settings", "Settings"],
    ["/user/account/billing", "Billing"], ["/user/account/plans", "Plans"], ["/user/account/payouts", "Receive payments"], ["/user/account/kyc", "KYC"], ["/user/editOwner", "Profile"],
    ["/user/addnewhostel", "Add property"], ["/login", "Owner login"], ["/signup", "Owner sign-up"]],
};
// Things people do (a form or button that changes something). [method, path, label, area]
const ACTIONS = {
  owner: [
    ["POST", "/user/newMember", "Added a tenant", "tenants"], ["POST", "/user/tenants/:id/payments", "Recorded a payment", "payments"], ["POST", "/user/tenants/:id/charges", "Added a charge", "payments"],
    ["POST", "/user/tenants/:id/entries/:pid/cancel", "Cancelled a ledger entry", "payments"], ["POST", "/user/tenants/:id/deposit", "Changed a deposit", "tenants"], ["POST", "/user/tenants/:id/move-out", "Moved a tenant out", "tenants"],
    ["POST", "/user/tenants/:id/undo-move-out", "Undid a move-out", "tenants"], ["POST", "/user/tenants/:id/notice", "Gave notice", "tenants"], ["POST", "/user/tenants/:id/notice/cancel", "Cancelled a notice", "tenants"],
    ["POST", "/user/tenants/:id/notice-request/:what", "Answered a notice request", "tenants"], ["POST", "/user/tenants/:id/stay", "Changed a stay", "tenants"], ["POST", "/user/tenants/:id/person", "Edited tenant details", "tenants"],
    ["POST", "/user/tenants/:id/documents", "Uploaded a tenant document", "tenants"], ["POST", "/user/tenants/:id/documents/:doc/delete", "Deleted a tenant document", "tenants"], ["POST", "/user/tenants/:id/remind", "Sent a rent reminder", "payments"],
    ["POST", "/user/tenants/:id/slip/send", "Sent a move-out slip", "tenants"], ["POST", "/user/members/:id/move", "Moved a tenant to another bed", "rooms"], ["POST", "/user/members/:id/rent-reset", "Reset a tenant's rent", "tenants"],
    ["DELETE", "/user/member/:id", "Removed a tenant", "tenants"], ["PUT", "/user/member-edit/:id", "Edited a tenant", "tenants"], ["POST", "/user/activeMember/:id", "Changed a tenant's status", "tenants"], ["POST", "/user/addpayment/:id", "Recorded a payment", "payments"],
    ["POST", "/user/newroom", "Added a room", "rooms"], ["POST", "/user/rooms/bulk", "Added rooms", "rooms"], ["PUT", "/user/manageroom/:id", "Edited a room", "rooms"], ["DELETE", "/user/managerooms/:id", "Deleted a room", "rooms"],
    ["POST", "/user/rooms/:id/beds/:label/block", "Blocked or unblocked a bed", "rooms"], ["POST", "/user/rooms/:id/beds/:label/rent", "Changed a bed's rent", "rooms"], ["POST", "/user/rooms/:id/beds/add", "Added a bed", "rooms"],
    ["POST", "/user/newfloor", "Added a floor", "rooms"], ["POST", "/user/floors/:id/rename", "Renamed a floor", "rooms"], ["POST", "/user/floors/:id/move", "Moved a floor", "rooms"], ["DELETE", "/user/managefloor/:id", "Deleted a floor", "rooms"],
    ["POST", "/user/create-hostel", "Added a property", "properties"], ["POST", "/user/editOwner", "Edited their profile", "account"],
    ["POST", "/user/new-list-property", "Created a listing", "listings"], ["POST", "/user/listing/:id/edit", "Edited a listing", "listings"], ["POST", "/user/listing/:id/publish", "Published a listing", "listings"],
    ["POST", "/user/listing/:id/delete", "Deleted a listing", "listings"], ["POST", "/user/listing/:id/link", "Linked a listing to a property", "listings"], ["POST", "/user/listing/:id/booking", "Changed online booking settings", "listings"],
    ["DELETE", "/user/listing/:id/review/:rid", "Deleted a review", "listings"],
    ["POST", "/user/bookings/:id/accept", "Accepted a booking", "bookings"], ["POST", "/user/bookings/:id/decline", "Declined a booking", "bookings"], ["POST", "/user/bookings/:id/cancel", "Cancelled a booking", "bookings"], ["POST", "/user/bookings/:id/noshow", "Marked a no-show", "bookings"],
    ["POST", "/user/enquiries/:id/status", "Changed a lead's status", "leads"], ["POST", "/user/enquiries/:id/chat", "Started a chat from a lead", "leads"],
    ["POST", "/user/expenses", "Added an expense", "reports"], ["POST", "/user/expenses/:id", "Edited an expense", "reports"], ["POST", "/user/expenses/:id/delete", "Deleted an expense", "reports"], ["POST", "/user/dues/reminders", "Changed rent reminder settings", "payments"],
    ["POST", "/user/account/checkout/:plan/order", "Started a plan payment", "plan"], ["POST", "/user/account/checkout/verify", "Paid for a plan", "plan"],
    ["POST", "/user/account/payouts", "Saved payout details", "payouts"], ["POST", "/user/account/payouts/bank", "Saved bank details", "payouts"], ["POST", "/user/account/payouts/online", "Changed online rent for a property", "payouts"], ["POST", "/user/account/payouts/refresh", "Checked payout status", "payouts"],
    ["POST", "/user/account/kyc", "Started KYC", "kyc"], ["POST", "/user/kyc/request", "Asked a tenant for KYC", "kyc"], ["POST", "/user/kyc/start", "Started a tenant's KYC", "kyc"],
    ["POST", "/user/account/settings/alerts", "Changed alert settings", "account"], ["POST", "/user/account/settings/password", "Changed their password", "security"],
    ["POST", "/user/:id/messages", "Sent a message", "messages"], ["POST", "/messages/:id/messages", "Sent a message", "messages"],
  ],
  main: [
    ["POST", "/student/enquiry", "Sent an enquiry", "leads"], ["POST", "/student/contact-owner", "Contacted an owner", "leads"], ["POST", "/student/review/:id", "Wrote a review", "listings"], ["DELETE", "/student/review/:id", "Deleted their review", "listings"],
    ["POST", "/student/wishlist/toggle/:id", "Changed their wishlist", "listings"], ["POST", "/student/saved/toggle", "Saved a listing", "listings"], ["POST", "/student/edit-profile", "Edited their profile", "account"],
    ["POST", "/student/kyc/start", "Started KYC", "kyc"], ["POST", "/student/kyc/share", "Shared KYC with an owner", "kyc"],
    ["POST", "/student/book/:id/kyc", "Did KYC to book a bed", "bookings"], ["POST", "/student/book/:id/order", "Started a booking payment", "bookings"], ["POST", "/student/bookings/verify", "Paid for a booking", "bookings"], ["POST", "/student/bookings/:id/cancel", "Cancelled a booking", "bookings"],
    ["POST", "/student/my-pg/order", "Started a rent payment", "rent"], ["POST", "/student/my-pg/verify", "Paid rent online", "rent"], ["POST", "/student/my-pg/notice", "Gave notice to leave", "rent"], ["POST", "/student/my-pg/notice/withdraw", "Withdrew their notice", "rent"],
    ["POST", "/messages/pg/start", "Started a chat with an owner", "messages"], ["POST", "/messages/:id/messages", "Sent a message", "messages"], ["POST", "/messages/connection/:id/accept", "Accepted a flatmate request", "flatmate"],
    ["POST", "/messages/connection/:id/decline", "Declined a flatmate request", "flatmate"], ["POST", "/messages/connection/:id/remove", "Removed a flatmate connection", "flatmate"], ["POST", "/messages/block/:id", "Blocked someone", "messages"], ["POST", "/messages/report", "Reported someone", "messages"],
    ["POST", "/flatmate/create/draft", "Saved a flatmate draft", "flatmate"], ["POST", "/flatmate/create/publish", "Published a flatmate listing", "flatmate"], ["POST", "/flatmate/listing/:id/pause", "Paused a flatmate listing", "flatmate"],
    ["POST", "/flatmate/listing/:id/reactivate", "Reactivated a flatmate listing", "flatmate"], ["POST", "/flatmate/listing/:id/close", "Closed a flatmate listing", "flatmate"], ["POST", "/flatmate/listing/:id/delete", "Deleted a flatmate listing", "flatmate"],
    ["POST", "/flatmate/connect", "Sent a flatmate request", "flatmate"], ["POST", "/flatmate/connection/:id/cancel", "Cancelled a flatmate request", "flatmate"], ["POST", "/flatmate/saved-searches", "Saved a flatmate search", "flatmate"], ["DELETE", "/flatmate/saved-searches/:id", "Deleted a saved search", "flatmate"],
  ],
};
// Sign-in steps (outcome read from the response). [method, path, type, who, cookie that proves success]
const AUTH = {
  main: [["POST", "/student/send-otp", "otp_sent", "student", ""], ["POST", "/student/verify-otp", "otp_verified", "student", ""], ["POST", "/student/signup", "signup", "student", "studentToken"],
    ["POST", "/student/login", "login", "student", "studentToken"], ["GET", "/student/logout", "logout", "student", ""], ["POST", "/student/logout", "logout", "student", ""],
    ["POST", "/user/login", "login", "owner", "token"], ["POST", "/user/signup", "signup", "owner", "token"], ["POST", "/user/send-otp", "otp_sent", "owner", ""], ["POST", "/user/verify-otp", "otp_verified", "owner", ""], ["GET", "/user/logout", "logout", "owner", ""],
    ["POST", "/admin/login", "login", "admin", "adminToken"], ["POST", "/admin/send-phone-otp", "otp_sent", "admin", ""], ["POST", "/admin/verify-phone-otp", "otp_verified", "admin", ""], ["GET", "/admin/logout", "logout", "admin", ""]],
  owner: [["POST", "/user/login", "login", "owner", "token"], ["POST", "/user/signup", "signup", "owner", "token"], ["POST", "/user/send-otp", "otp_sent", "owner", ""], ["POST", "/user/verify-otp", "otp_verified", "owner", ""],
    ["GET", "/user/logout", "logout", "owner", ""], ["POST", "/user/forgot-password", "password_reset_asked", "owner", ""], ["POST", "/user/reset-password/:token", "password_reset", "owner", ""]],
};
const compiled = {};
function table(site) {
  if (compiled[site]) return compiled[site];
  compiled[site] = {
    pages: (PAGES[site] || []).map(([p, l]) => [rx(p), l]),
    actions: (site === "main" ? ACTIONS.main.concat(ACTIONS.owner) : ACTIONS[site] || []).map(([m, p, l, a]) => [m, rx(p), l, a]),
    auth: (AUTH[site] || []).map(([m, p, t, w, c]) => [m, rx(p), t, w, c]),
  };
  return compiled[site];
}
const SKIP = /^\/(hn|webhook|payments\/razorpay\/webhook|favicon|robots\.txt|sitemap|css|js|images|img|fonts|uploads|student-images|profile-image|listing-images|flatmate-images)(\/|$)|\.(css|js|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|txt|xml)$/i;
const SKIP_ACTIONS = /\/(read|read-all|open|search|searchfeesrecords|track-location|recently-viewed\/.*)$|\/notifications\//;
// Secrets in links (password-reset and invite tokens, …) are never stored: any long random-looking
// part of a path, other than a database id, is replaced by "…".
// (long hex, or long mixed-case letters+digits; listing slugs are lower-case words, so they stay)
const isToken = s => !isId(s) && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (/^[a-f0-9]{30,}$/i.test(s)) || (s.length >= 20 && /^[A-Za-z0-9_-]+$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)));
function cleanPath(path) {
  return String(path || "").split("/").map((seg, i, all) => (isToken(seg) || (i > 0 && /^(reset-password|reset|verify-email|invite|magic|token)$/i.test(all[i - 1]) && seg) ? "…" : seg)).join("/").slice(0, 300);
}
function pageLabel(site, path) {
  for (const [r, l] of table(site).pages) if (r.test(path)) return l;
  const seg = cleanPath(path).split("/").filter(Boolean).filter(s => !isId(s) && !/^\d+$/.test(s) && s !== "user" && s !== "…").slice(0, 3).join(" · ");
  return seg ? seg.replace(/[-_]/g, " ") : "Home";
}
const targetOf = path => { const m = String(path).match(/\/([0-9a-f]{24})(?:\/|$)/i); return m ? { kind: "", id: m[1] } : { kind: "", id: "" }; };

/* ── masking ──────────────────────────────────────────────── */
const { ten, maskPhone, maskEmail, hashPhone, hashEmail } = require("./hnPii");

/* ── the middleware ───────────────────────────────────────── */
const recent = new Map();   // vid|path → time (a reload within 10 s counts once)
const presenceAt = new Map();
function seenRecently(key, ms) {
  const now = Date.now(), t = recent.get(key);
  if (recent.size > 20000) recent.clear();
  recent.set(key, now);
  return t && now - t < ms;
}
// The visitor cookie is "<random id>.<signature>", so made-up ids are not believed.
const VID_FALLBACK = crypto.randomBytes(32).toString("hex");   // only if neither secret is set (then ids last until a restart)
const vidSig = v => crypto.createHmac("sha256", String(process.env.JWT_SECRET || process.env.HN_PII_KEY || VID_FALLBACK)).update("vid:" + v).digest("hex").slice(0, 16);
function vidFrom(req) {
  const raw = String((req && req.cookies && req.cookies.hn_vid) || "");
  const m = raw.match(/^([a-f0-9]{32})\.([a-f0-9]{16})$/);
  if (!m) return "";
  const want = vidSig(m[1]);
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(want)) ? m[1] : "";
}
function vidOf(req, res) {
  let v = vidFrom(req);
  if (!v) {
    v = crypto.randomBytes(16).toString("hex");
    try {
      const secure = !!(req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https"));
      if (!res.headersSent) res.cookie("hn_vid", v + "." + vidSig(v), { httpOnly: true, sameSite: "lax", secure, maxAge: 365 * 24 * 3600 * 1000, path: "/" });
    } catch { /* headers already gone */ }
  }
  req.hnVid = v;   // so the first request of a new visitor already has its id (search log, …)
  return v;
}
function setCookieToken(res, name) {
  const sc = res.getHeader("set-cookie");
  const list = Array.isArray(sc) ? sc : sc ? [String(sc)] : [];
  for (const c of list) { const m = String(c).match(new RegExp("^" + name + "=([^;]+)")); if (m && m[1]) return decodeURIComponent(m[1]); }
  return "";
}
async function touchPresence(site, actor, vid, fields, internal) {
  const key = site + ":" + (actor.id || vid);
  const last = presenceAt.get(key) || 0;
  if (Date.now() - last < 20000 && !fields.force) return;
  presenceAt.set(key, Date.now());
  if (presenceAt.size > 20000) presenceAt.clear();
  try {
    const P = require("../models/hnPresence");
    const set = { site, actor, vid, at: new Date(), internal: !!internal };
    for (const k of ["path", "label", "geo", "ua", "ref"]) if (fields[k] !== undefined) set[k] = fields[k];
    if (fields.onlyExisting) await P.collection.updateOne({ _id: key }, { $set: set });
    else await P.collection.updateOne({ _id: key }, { $set: set, $setOnInsert: { since: new Date() } }, { upsert: true });
  } catch (err) { console.error("Presence (non-fatal):", err.message); }
}

function middleware(site) {
  SITE = site;
  ensureIndexes();
  return (req, res, next) => {
    if (!trackingOn()) return next();
    const path = String(req.path || "/");
    if (SKIP.test(path)) return next();
    const started = Date.now();
    const method = req.method;
    const t = table(site);
    const auth = t.auth.find(([m, r]) => m === method && r.test(path));
    let actor = null;
    try { actor = actorOf(req); } catch { actor = { kind: "guest", id: null, name: "" }; }
    let vid = "";
    if (method === "GET") { try { vid = vidOf(req, res); } catch { vid = ""; } } else vid = vidFrom(req);
    // Pages get the small tracking script (heartbeat + location card) added before </body>.
    if (method === "GET" && !(site === "main" && /^\/admin(\/|$)/.test(path))) {
      const send = res.send.bind(res);
      res.send = body => {
        try {
          if (typeof body === "string" && res.statusCode < 400 && /text\/html/.test(String(res.getHeader("content-type") || "text/html")) && !body.includes("/hn/track.js")) {
            const i = body.lastIndexOf("</body>");
            if (i !== -1) body = body.slice(0, i) + '<script src="/hn/track.js" defer></script>' + body.slice(i);
          }
        } catch { /* send as it was */ }
        return send(body);
      };
    }
    // What a sign-in step answered (JSON APIs say { success: true/false }).
    let jsonOk = null;
    if (auth) {
      const json = res.json.bind(res);
      res.json = body => { try { if (body && typeof body === "object" && "success" in body) jsonOk = !!body.success; } catch { /* ignore */ } return json(body); };
    }
    const bodyIn = (auth && req.body && typeof req.body === "object") ? req.body : {};
    const userIn = bodyIn.user && typeof bodyIn.user === "object" ? bodyIn.user : {};
    const phoneIn = String(bodyIn.phone || bodyIn.mobile || bodyIn.phoneNumber || userIn.phone || "");
    const emailIn = String(bodyIn.email || userIn.email || "");
    res.on("finish", () => {
      setImmediate(async () => {
        try {
          const status = res.statusCode;
          const ip = ipOf(req);
          const { ua, bot } = uaOf(req.headers["user-agent"]);
          const internal = await internalOf(req, ip, actor);
          const base = { at: new Date(started), site, method, path: cleanPath(path), status, ms: Date.now() - started, ip, geo: geoOf(ip), ua, bot, internal, vid, ref: refOf(req) };
          if (auth) {
            const [, , type, who, cookie] = auth;
            let ok = status < 400;
            let a = actor;
            if (cookie) { const tok = setCookieToken(res, cookie); const d = tok ? jwt.decode(tok) : null; ok = !!(d && d.id); if (ok) a = { kind: who, id: isId(d.id) ? String(d.id) : null, name: "" }; else a = { kind: who === "admin" ? "admin" : "guest", id: null, name: "" }; }
            else if (jsonOk !== null) ok = jsonOk;
            const failType = type === "login" ? "login_failed" : type === "signup" ? "signup_failed" : type === "otp_verified" ? "otp_failed" : type === "otp_sent" ? "otp_send_failed" : type === "password_reset" ? "password_reset_failed" : type;
            const meta = {};
            if (phoneIn) { meta.phone = maskPhone(phoneIn); meta.phoneHash = hashPhone(phoneIn); }
            if (emailIn) { meta.email = maskEmail(emailIn); meta.emailHash = hashEmail(emailIn); }
            meta.who = who;
            // New device = this account never signed in from this browser before (since tracking began).
            if (ok && type === "login" && a.id && vid) {
              try {
                const A = require("../models/hnActivity");
                const seen = await A.collection.findOne({ "actor.id": toActor(a).id, type: "login", vid }, { projection: { _id: 1 } });
                meta.newDevice = !seen;
              } catch { /* unknown */ }
            }
            push(Object.assign(base, { type: ok ? type : failType, outcome: ok ? "ok" : "failed", actor: toActor(a), label: labelFor(ok ? type : failType, who), area: "security", meta }));
            if (ok && type === "logout") presenceDrop(site, actor, vid);
            return;
          }
          if (method === "GET") {
            const ct = String(res.getHeader("content-type") || "");
            if (status >= 400 || !/text\/html/.test(ct)) return;
            if (site === "main" && /^\/admin(\/|$)/.test(path)) return;   // the old admin pages are not visitor traffic
            if (vid && seenRecently(vid + "|" + path, 10000)) return;
            const label = pageLabel(site, path);
            const meta = {};
            const lm = site === "main" && path.match(/^\/hostel\/([^/]+)\/?$/);
            if (lm) meta.listing = lm[1].slice(0, 120);
            push(Object.assign(base, { type: "page", outcome: "ok", actor: toActor(actor), label, area: "", target: targetOf(path), meta: Object.keys(meta).length ? meta : undefined }));
            if (!bot) touchPresence(site, toActor(actor), vid, { path: base.path, label, geo: base.geo, ua, ref: base.ref }, internal);
            return;
          }
          if (actor.kind === "guest" || SKIP_ACTIONS.test(path)) return;
          const hit = t.actions.find(([m, r]) => m === method && r.test(path));
          const label = hit ? hit[2] : (/^\/admin(\/|$)/.test(path) ? "Old admin: " : "Sent a form: ") + pageLabel(site, path);
          push(Object.assign(base, { type: "action", outcome: status < 400 ? "ok" : "failed", actor: toActor(actor), label, area: hit ? hit[3] : "", target: targetOf(path) }));
        } catch (err) { console.error("Activity (non-fatal):", err.message); }
      });
    });
    next();
  };
}
function toActor(a) {
  const mongoose = require("mongoose");
  return { kind: a.kind, id: a.id && isId(a.id) ? new mongoose.Types.ObjectId(String(a.id)) : null, name: a.name || "" };
}
function labelFor(type, who) {
  const w = { owner: "Owner", student: "Student", admin: "Admin" }[who] || "";
  return ({ login: w + " signed in", login_failed: w + " sign-in failed", logout: w + " signed out", signup: w + " signed up", signup_failed: w + " sign-up failed", otp_sent: (w ? w + " asked" : "Asked") + " for a sign-in code", otp_failed: (w ? w + " sign-in code" : "Sign-in code") + " refused", otp_verified: (w ? w + " sign-in code" : "Sign-in code") + " accepted", otp_send_failed: (w ? w + " sign-in code" : "Sign-in code") + " not sent", password_reset_asked: "Asked for a password reset", password_reset: "Reset their password", password_reset_failed: "Password reset failed" })[type] || type;
}
async function presenceDrop(site, actor, vid) {
  try { const P = require("../models/hnPresence"); await P.collection.deleteOne({ _id: site + ":" + (actor.id || vid) }); presenceAt.delete(site + ":" + (actor.id || vid)); } catch { /* ignore */ }
}

/** For other modules: record one event (search, …). ev: { type, req?, actor?, label, area, meta, target } */
function record(ev) {
  try {
    if (!trackingOn()) return;
    const req = ev.req;
    const ip = req ? ipOf(req) : "";
    const actor = ev.actor || (req ? actorOf(req) : { kind: "guest", id: null, name: "" });
    const { ua, bot } = uaOf(req ? req.headers["user-agent"] : "");
    push({ at: new Date(), site: SITE, type: ev.type || "event", outcome: ev.outcome || "ok", actor: toActor(actor), vid: (req && (req.hnVid || vidFrom(req))) || "", method: req ? req.method : "", path: req ? String(req.path || "").slice(0, 300) : "",
      label: ev.label || "", area: ev.area || "", status: 0, ms: 0, target: ev.target || { kind: "", id: "" }, meta: ev.meta, ip, geo: geoOf(ip), ua, bot, internal: false, ref: req ? refOf(req) : "" });
  } catch (err) { console.error("Activity (non-fatal):", err.message); }
}

/* ── /hn/* : heartbeat, location, the browser script ─────────── */
const vidCookie = req => vidFrom(req);
const rate = new Map();
function tooMany(req, kind, perMin, who) {
  const k = kind + "|" + (who || ipOf(req)), now = Date.now();
  const e = rate.get(k);
  if (!e || now - e.t > 60000) { rate.set(k, { t: now, n: 1 }); if (rate.size > 20000) rate.clear(); return false; }
  e.n++;
  return e.n > perMin;
}
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
function routes() {
  const r = express.Router();
  const jp = express.json({ limit: "4kb", type: () => true });   // only on these two routes (never on uploads)
  r.post("/hn/ping", jp, async (req, res) => {
    res.status(204).end();
    try {
      if (!trackingOn() || tooMany(req, "ping-ip", 600)) return;   // many people can share one IP (mobile data, college Wi-Fi)
      const { ua, bot } = uaOf(req.headers["user-agent"]);
      if (bot) return;
      const actor = actorOf(req), vid = vidCookie(req);
      if (!actor.id && !vid) return;
      if (tooMany(req, "ping", 10, actor.id || vid)) return;
      const path = cleanPath(String((req.body && req.body.p) || "").split("?")[0]);
      const ip = ipOf(req);
      const internal = await internalOf(req, ip, actor);
      // Visitors who aren't signed in are only kept online, never added, by a heartbeat
      // (a real page view adds them), so made-up cookies can't inflate "online now".
      await touchPresence(SITE, toActor(actor), vid, Object.assign({ ua, force: true, onlyExisting: !actor.id }, path && path.startsWith("/") ? { path, label: pageLabel(SITE, path) } : {}), internal);
    } catch (err) { console.error("Ping (non-fatal):", err.message); }
  });
  r.post("/hn/loc", jp, async (req, res) => {
    try {
      if (!trackingOn()) return res.status(204).end();
      if (tooMany(req, "loc-ip", 120) || tooMany(req, "loc", 10, actorOf(req).id || vidCookie(req))) return res.status(429).json({ ok: false });
      const b = req.body || {};
      const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180), acc = num(b.acc, 0, 100000);
      if (lat === null || lng === null) return res.status(400).json({ ok: false });
      const actor = actorOf(req), vid = vidCookie(req);
      if (!actor.id && !vid) return res.status(400).json({ ok: false });
      const ip = ipOf(req);
      const ipGeo = geoOf(ip);
      const geo = { src: "gps", city: ipGeo.city || "", region: ipGeo.region || "", country: ipGeo.country || "", lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, acc: acc === null ? null : Math.round(acc) };
      const { ua, bot } = uaOf(req.headers["user-agent"]);
      const internal = await internalOf(req, ip, actor);
      push({ at: new Date(), site: SITE, type: "location", outcome: "ok", actor: toActor(actor), vid, method: "POST", path: cleanPath(String(b.p || "").split("?")[0]), label: "Shared their location", area: "location", status: 200, ms: 0, target: { kind: "", id: "" }, meta: { why: String(b.why || "").slice(0, 20) }, ip, geo, ua, bot, internal, ref: "" });
      touchPresence(SITE, toActor(actor), vid, { geo, force: true, onlyExisting: !actor.id }, internal);
      res.json({ ok: true });
    } catch (err) { console.error("Location (non-fatal):", err.message); res.status(204).end(); }
  });
  r.get("/hn/track.js", async (req, res) => {
    let prompt = true;
    try { const t = await settings().tracking(); prompt = t.on && t.gpsPrompt; } catch { prompt = true; }
    if (!trackingOn()) prompt = false;
    res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, max-age=300" });
    res.send(clientScript(SITE, prompt));
  });
  return r;
}

/* The browser part: a heartbeat every 60 s while the page is visible, and the
   location card. GPS is read ONLY after the person taps Allow (or allowed
   before); otherwise nothing is asked again for 30 days. */
function clientScript(site, prompt) {
  const owner = site === "owner";
  const text = owner
    ? { t: "Share your location?", b: "HostelNode uses it to keep your account safe and to see where demand for PGs is. It is only read while this page is open.", y: "Allow", n: "Not now" }
    : { t: "Share your location?", b: "HostelNode uses it to see which areas students look for PGs in, so more PGs get listed near you. It is only read while this page is open.", y: "Allow", n: "Not now" };
  return `(function(){try{
var S=${JSON.stringify(site)},P=${prompt ? "true" : "false"},T=${JSON.stringify(text)},K="hn_loc",D=30*864e5;
function get(k){try{return JSON.parse(localStorage.getItem(k)||"null")}catch(e){return null}}
function put(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function send(u,o){try{var b=JSON.stringify(o);if(navigator.sendBeacon&&navigator.sendBeacon(u,new Blob([b],{type:"application/json"})))return;fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:b,credentials:"same-origin",keepalive:true})}catch(e){}}
function ping(){if(document.visibilityState==="visible")send("/hn/ping",{p:location.pathname})}
setInterval(ping,60000);document.addEventListener("visibilitychange",ping);
function far(a,b){if(!a||!b)return true;var r=Math.PI/180,x=(b.lng-a.lng)*r*Math.cos((a.lat+b.lat)*r/2),y=(b.lat-a.lat)*r;return Math.sqrt(x*x+y*y)*6371000>500}
function locate(why){if(!navigator.geolocation)return;navigator.geolocation.getCurrentPosition(function(p){var c={lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy,at:Date.now()};var last=get("hn_loc_last");if(why!=="near")put(K,{v:"yes",at:Date.now()});if(far(last,c)||!last||Date.now()-last.at>6e5){put("hn_loc_last",c);send("/hn/loc",{lat:c.lat,lng:c.lng,acc:c.acc,p:location.pathname,why:why})}},function(){put(K,{v:"no",at:Date.now()})},{enableHighAccuracy:true,timeout:15000,maximumAge:120000})}
window.hnLocate=function(){locate("near")};
var c=get(K);
function card(){if(document.getElementById("hn-loc-card"))return;var d=document.createElement("div");d.id="hn-loc-card";d.setAttribute("role","dialog");d.setAttribute("aria-label",T.t);
d.style.cssText="position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:320px;background:#fff;color:#10231b;border:1px solid #e2ece7;border-radius:16px;box-shadow:0 18px 40px -18px rgba(16,35,27,.45);padding:14px 16px;font:500 14px/1.45 Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif";
d.innerHTML='<div style="font-weight:800;font-size:15px;margin-bottom:4px"></div><div style="color:#3d4f47;margin-bottom:12px"></div><div style="display:flex;gap:8px"><button type="button" data-y style="flex:1;height:38px;border:0;border-radius:10px;background:#0a7d4c;color:#fff;font-weight:700;cursor:pointer"></button><button type="button" data-n style="flex:1;height:38px;border:1px solid #cfdcd5;border-radius:10px;background:#fff;color:#10231b;font-weight:700;cursor:pointer"></button></div>';
d.children[0].textContent=T.t;d.children[1].textContent=T.b;d.querySelector("[data-y]").textContent=T.y;d.querySelector("[data-n]").textContent=T.n;
d.querySelector("[data-y]").onclick=function(){d.remove();locate("card")};d.querySelector("[data-n]").onclick=function(){d.remove();put(K,{v:"no",at:Date.now()})};document.body.appendChild(d)}
function start(){ping();
var yes=c&&c.v==="yes",asked=c&&Date.now()-c.at<D;
// Location is read only after the person tapped Allow on this card (even if the browser already allows it).
if(navigator.permissions&&navigator.permissions.query){navigator.permissions.query({name:"geolocation"}).then(function(s){if(s.state==="granted"&&yes){locate("granted")}else if(s.state!=="denied"&&P&&!yes&&!asked&&ok()){setTimeout(card,4000)}}).catch(function(){})}
else if(yes){locate("granted")}else if(P&&!asked&&ok()){setTimeout(card,4000)}}
function ok(){if(window.top!==window.self)return false;var p=location.pathname;if(S==="owner")return p==="/user"||p==="/user/";return !/^\\/(admin|student\\/login|student\\/signup|login|signup)/.test(p)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
}catch(e){}})();`;
}

/* ── indexes, once ────────────────────────────────────────── */
let indexed = false;
function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  const mongoose = require("mongoose");
  const go = () => {
    for (const m of ["hnActivity", "hnPresence", "hnWaMessage", "hnEmailLog"]) {
      try { require("../models/" + m).createIndexes().catch(err => console.error(`Index ${m} (non-fatal):`, err.message)); } catch { /* ignore */ }
    }
  };
  if (mongoose.connection.readyState === 1) go(); else mongoose.connection.once("connected", go);
}

/** Is this request from the HostelNode team, an office IP or a test account? Uses the cached
    settings only, so it never waits for the database. */
function isInternalNow(req) {
  try {
    const ip = ipOf(req), actor = actorOf(req);
    if (String(process.env.HN_INTERNAL_IPS || "").split(",").map(x => x.trim()).includes(ip)) return true;
    if (actor.kind === "admin" || (SITE === "main" && req.cookies && req.cookies.adminToken && verify(req.cookies.adminToken))) return true;
    const t = settings().peek("tracking") || {};
    if ((t.internalIps || []).includes(ip)) return true;
    if (actor.id && (t.testIds || []).map(String).includes(String(actor.id))) return true;
  } catch { /* not internal */ }
  return false;
}

module.exports = { middleware, routes, record, isInternalNow, vidFrom, actorOf, ipOf, geoOf, uaOf, maskPhone, maskEmail, hashPhone, hashEmail, ten, pageLabel, cleanPath, site: () => SITE, setSite: s => { SITE = s; }, flush, _queue: queue };
