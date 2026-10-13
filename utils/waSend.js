/* ============================================================
   utils/waSend.js  —  Admin Console Phase 1 (WhatsApp)
   SHARED: identical in hostelnode.com and manage.hostelnode.com.

   The one door every WhatsApp message goes out through. For each
   message it:
     1. checks the admin console's switches (whole WhatsApp, a category
        such as "rent", or one template). OTP messages can never be
        switched off — people must always be able to sign in;
     2. sends it to Meta (same request the code made before);
     3. writes a row to hn_wa_messages: category, template, the number
        masked + hashed (never in full), Meta's message id, and whether
        Meta accepted it (with Meta's error if not).
   Meta's receipts arrive later on the WhatsApp webhook: receipts(body)
   moves the row on to delivered / read / failed, with Meta's pricing
   category. Messages people send to the HostelNode number are logged
   too (inbound(body)).

   post() never throws. It returns { ok, status, data, error, off }.
   WA_API_BASE (tests only) replaces https://graph.facebook.com/v19.0.
============================================================ */
const crypto = require("crypto");

const TIMEOUT_MS = 15000;
const apiBase = () => String(process.env.WA_API_BASE || "https://graph.facebook.com/v19.0").replace(/\/$/, "") + "/" + process.env.WA_PHONE_ID;
const LOCKED_ON = new Set(["otp"]);

const { ten, maskPhone, hashPhone } = require("./hnPii");

/* ── Which category a template belongs to ─────────────────────
   1. the caller says so (best), else
   2. the .env key that holds this template name (WA_TEMPLATE_RENT_DUE → rent), else
   3. the template name itself (hostelnode_flatmate_… → flatmate). */
const ENV_PREFIX = [[/^WA_TEMPLATE_BOOKING_/, "bookings"], [/^WA_TEMPLATE_FLATMATE_/, "flatmate"], [/^WA_TEMPLATE_PG_NEW_MESSAGE$/, "messages"], [/^WA_TEMPLATE_PLAN_/, "billing"],
  [/^WA_TEMPLATE_RENT_/, "rent"], [/^WA_TEMPLATE_(TENANT_|SETTLEMENT_)/, "tenants"], [/^WA_TEMPLATE_ADMIN_OTP$/, "otp"]];
const NAME_RULES = [[/otp|verif|auth/i, "otp"], [/flatmate/i, "flatmate"], [/booking/i, "bookings"], [/enquir|lead/i, "leads"], [/new_message|pg_message/i, "messages"],
  [/rent/i, "rent"], [/tenant|settlement|welcome/i, "tenants"], [/plan|subscription|invoice/i, "billing"]];
const CATEGORIES = ["otp", "leads", "messages", "bookings", "tenants", "rent", "billing", "flatmate", "bot", "chat", "other"];
function categoryOf(template, kind) {
  const name = String(template || "").trim();
  if (!name) return kind === "bot" ? "bot" : "chat";
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("WA_TEMPLATE_") || k.endsWith("_LANG") || String(v || "").trim() !== name) continue;
    const hit = ENV_PREFIX.find(([r]) => r.test(k));
    if (hit) return hit[1];
  }
  const hit = NAME_RULES.find(([r]) => r.test(name));
  return hit ? hit[1] : "other";
}

function site() { try { return require("./activity").site() || ""; } catch { return ""; } }
const oid = v => { try { const m = require("mongoose"); return v && /^[0-9a-f]{24}$/i.test(String(v)) ? new m.Types.ObjectId(String(v)) : null; } catch { return null; } };

async function log(row) {
  try {
    const W = require("../models/hnWaMessage");
    if (row.wamid) {
      const { wamid, ...rest } = row;
      // Receipts never move a row backwards: if one already arrived, keep its status.
      await W.collection.updateOne({ wamid }, { $setOnInsert: Object.assign({ wamid }, rest) }, { upsert: true });
    } else {
      await W.collection.insertOne(row);
    }
  } catch (err) { console.error("WhatsApp log (non-fatal):", err.message); }
}

/**
 * Send one message.
 * body: the Meta request body (messaging_product, to, type, template | text | …).
 * meta: { category?, refs?: { owner, student, member, booking } }
 */
async function post(body, meta = {}) {
  const template = (body && body.template && body.template.name) || "";
  const kind = (body && body.type) || "";
  const category = meta.category && CATEGORIES.includes(meta.category) ? meta.category : categoryOf(template, meta.kind);
  const now = new Date();
  const row = {
    at: now, site: site(), direction: "out", category, template, lang: (body && body.template && body.template.language && body.template.language.code) || "", kind,
    toMasked: maskPhone(body && body.to), toHash: hashPhone(body && body.to),
    refs: { owner: oid(meta.refs && meta.refs.owner), student: oid(meta.refs && meta.refs.student), member: oid(meta.refs && meta.refs.member), booking: oid(meta.refs && meta.refs.booking) },
    wamid: "", status: "sent", rank: 1, error: { code: "", message: "" }, sentAt: now, pricing: { category: "", billable: null }, body: "",
  };
  try {
    if (!LOCKED_ON.has(category)) {
      // At most 1.5 s waiting for the switches; if the database is slow, the message goes (switches default to on).
      const sw = await Promise.race([require("./hnSettings").wa(), new Promise(r => setTimeout(() => r(null), 1500).unref())]);
      if (sw && !sw.isOn(category, template)) {
        row.status = "off"; row.rank = 0; row.sentAt = undefined; delete row.sentAt;
        row.error = { code: "off", message: "Switched off in the admin console" };
        log(row);
        return { ok: false, off: true, status: 0, data: null, error: { message: "Switched off in the admin console" } };
      }
    }
  } catch { /* a switch problem never stops a message */ }

  let status = 0, data = null, error = null;
  try {
    const res = await fetch(apiBase() + "/messages", {
      method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: "Bearer " + process.env.WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) error = (data && data.error) || { message: "WhatsApp answered " + res.status };
  } catch (err) {
    error = { message: err.name === "TimeoutError" ? "No answer from WhatsApp in 15 seconds" : err.message };
  }
  const ok = !error;
  if (ok) {
    row.wamid = String((data && data.messages && data.messages[0] && data.messages[0].id) || "");
    const st = data && data.messages && data.messages[0] && data.messages[0].message_status;   // "accepted" / "held_for_quality_assessment"
    if (st && st !== "accepted") row.error = { code: "", message: String(st) };
  } else {
    row.status = "failed"; row.rank = 4; row.failedAt = now; delete row.sentAt;
    row.error = { code: String((error && (error.code || error.error_subcode)) || ""), message: String((error && (error.error_user_msg || error.message)) || "").slice(0, 300) };
  }
  log(row);   // written in the background; the caller doesn't wait for the log
  return { ok, off: false, status, data, error };
}

/* ── Webhook: Meta's receipts and incoming messages ───────────── */
const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };
function changesOf(body) {
  const out = [];
  for (const e of (body && Array.isArray(body.entry) ? body.entry : [])) for (const c of (Array.isArray(e.changes) ? e.changes : [])) if (c && c.value) out.push(c.value);
  return out;
}
async function applyStatus(s, retry) {
  const W = require("../models/hnWaMessage");
  const st = String(s.status || "");
  const rank = RANK[st];
  if (!rank || !s.id) return;
  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
  const set = { [st + "At"]: at };
  if (s.pricing) set.pricing = { category: String(s.pricing.category || ""), billable: typeof s.pricing.billable === "boolean" ? s.pricing.billable : null };
  if (st === "failed" && Array.isArray(s.errors) && s.errors[0]) set.error = { code: String(s.errors[0].code || ""), message: String(s.errors[0].error_data && s.errors[0].error_data.details || s.errors[0].message || s.errors[0].title || "").slice(0, 300) };
  const r1 = await W.collection.updateOne({ wamid: String(s.id) }, { $set: set });
  if (!r1.matchedCount) {
    // The send may still be writing its row: try again after 3, 10 and 30 seconds (then it was sent before this was installed).
    const n = Number(retry) || 0;
    if (n < 3) { const t = setTimeout(() => applyStatus(s, n + 1).catch(() => {}), [3000, 10000, 30000][n]); if (t.unref) t.unref(); }
    return;
  }
  await W.collection.updateOne({ wamid: String(s.id), rank: { $lt: rank } }, { $set: { status: st, rank } });
}

/** Meta's receipts: sent → delivered → read, or failed. Never throws. */
async function receipts(body) {
  try {
    for (const v of changesOf(body)) for (const s of (Array.isArray(v.statuses) ? v.statuses : [])) {
      try { await applyStatus(s, 0); } catch (err) { console.error("WhatsApp receipt (non-fatal):", err.message); }
    }
  } catch (err) { console.error("WhatsApp receipt (non-fatal):", err.message); }
}

/** Messages people send to the HostelNode number. Never throws. */
async function inbound(body) {
  try {
    const W = require("../models/hnWaMessage");
    for (const v of changesOf(body)) for (const m of (Array.isArray(v.messages) ? v.messages : [])) {
      if (!m || !m.id) continue;
      let text = "";
      if (m.type === "text") text = (m.text && m.text.body) || "";
      else if (m.type === "interactive") text = (m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) || (m.interactive.list_reply && m.interactive.list_reply.title))) || "";
      else if (m.type === "button") text = (m.button && m.button.text) || "";
      const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
      await W.collection.updateOne({ wamid: String(m.id) }, { $setOnInsert: {
        wamid: String(m.id), at, site: site(), direction: "in", category: "bot", template: "", lang: "", kind: String(m.type || ""),
        toMasked: maskPhone(m.from), toHash: hashPhone(m.from), refs: { owner: null, student: null, member: null, booking: null },
        status: "received", rank: 0, error: { code: "", message: "" }, body: String(text).slice(0, 500), pricing: { category: "", billable: null },
      } }, { upsert: true });
    }
  } catch (err) { console.error("WhatsApp inbound log (non-fatal):", err.message); }
}

/** True when the webhook request really came from Meta (only checked when WA_APP_SECRET is set). */
function signedByMeta(req) {
  const secret = String(process.env.WA_APP_SECRET || "").trim();
  if (!secret) return true;
  try {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    if (!sig.startsWith("sha256=") || !req.rawBody) return false;
    const want = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  } catch { return false; }
}

module.exports = { post, receipts, inbound, signedByMeta, categoryOf, maskPhone, hashPhone, ten, CATEGORIES, LOCKED_ON };
