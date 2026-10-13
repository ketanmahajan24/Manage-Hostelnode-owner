// ============================================================
//  utils/leadWhatsapp.js  —  HostelNode WA Utility
//  Clean version: only sendTemplateMessage + sendWAMessage
// ============================================================

const axios = require("axios");

const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const BASE_URL    = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;

// ── Format phone number ──────────────────────────────────────
function formatPhone(phone) {
  const clean = phone.toString().replace(/[^0-9]/g, "");
  return clean.startsWith("91") ? clean : `91${clean}`;
}

// ============================================================
//  sendTemplateMessage — Meta approved templates only
//
//  languageCode: Meta treats each template's language as a distinct
//  translation — "en" and "en_US" are NOT interchangeable, and asking
//  for a language a template wasn't approved under fails with API
//  error 132001 ("template name does not exist in the translation"),
//  even though the template genuinely exists. Defaults to "en" to
//  keep every pre-existing caller of this function working exactly as
//  before; callers whose template was approved under a specific
//  language (check the "Language" column in WhatsApp Manager) must
//  pass that exact code.
// ============================================================
async function sendTemplateMessage(phone, templateName, variables, headerImageUrl = null, languageCode = "en") {
  try {
    const fullPhone = formatPhone(phone);
    console.log(`🔵 Template [${templateName}] (${languageCode}) → ${fullPhone}`, variables);

    // Build components array
    const components = [];

    // ── Add header image if provided ──
    if (headerImageUrl) {
      components.push({
        type: "header",
        parameters: [{
          type: "image",
          image: { link: headerImageUrl }
        }]
      });
    }

    // ── Add body variables ──
    if (variables && variables.length > 0) {
      components.push({
        type: "body",
        parameters: variables.map(v => ({ type: "text", text: String(v || "") }))
      });
    }

    // Admin Console Phase 1: sent through utils/waSend.js (logged, and honours the admin's switches).
    const r = await require("./waSend").post({
      messaging_product: "whatsapp",
      to:   fullPhone,
      type: "template",
      template: {
        name:       templateName,
        language:   { code: languageCode },
        components
      }
    });
    if (!r.ok) throw Object.assign(new Error((r.error && r.error.message) || "not sent"), { response: { data: r.off ? "Switched off in the admin console" : { error: r.error } } });
    const res = { data: r.data };

    console.log(`🟢 Template sent → ${fullPhone}`);
    return { success: true, data: res.data };

  } catch (err) {
    console.error("🔴 Template send error:", JSON.stringify(err.response?.data || err.message));
    return { success: false, error: err.response?.data || err.message };
  }
}

// ============================================================
//  sendWAMessage — plain text (24hr window only)
// ============================================================
async function sendWAMessage(phone, message) {
  try {
    const fullPhone = formatPhone(phone);
    console.log(`🔵 Plain text WA → ${fullPhone}`);

    const r = await require("./waSend").post({
      messaging_product: "whatsapp",
      to:   fullPhone,
      type: "text",
      text: { body: message }
    }, { category: "chat" });
    if (!r.ok) throw Object.assign(new Error((r.error && r.error.message) || "not sent"), { response: { data: r.off ? "Switched off in the admin console" : { error: r.error } } });
    const res = { data: r.data };

    console.log(`🟢 WA sent → ${fullPhone}`);
    return { success: true, data: res.data };

  } catch (err) {
    console.error("🔴 WA send error:", JSON.stringify(err.response?.data || err.message));
    return { success: false, error: err.response?.data || err.message };
  }
}

module.exports = { sendTemplateMessage, sendWAMessage };