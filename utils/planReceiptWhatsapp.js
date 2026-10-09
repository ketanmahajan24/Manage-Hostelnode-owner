/* ============================================================
   utils/planReceiptWhatsapp.js  —  plan payment receipt on WhatsApp

   After an owner pays for a plan, the receipt is sent to their
   WhatsApp number as a PDF, from HostelNode's WhatsApp number
   (the one that sends OTPs). The receipt email still goes out too.

   WhatsApp only allows this with an APPROVED message template.
   Create it once in Meta WhatsApp Manager:

     Name      hostelnode_plan_receipt        Category  Utility
     Language  English (en)
     Header    Document            (upload any sample PDF when Meta asks)
     Body      Hi {{1}}, we received your payment for the HostelNode {{2}} plan.

               Amount paid: {{3}}
               Valid until: {{4}}
               Receipt no.: {{5}}

               Your receipt is attached as a PDF.

   Optional env:
     WA_TEMPLATE_PLAN_RECEIPT        template name (default hostelnode_plan_receipt); set to "off" to stop sending
     WA_TEMPLATE_PLAN_RECEIPT_LANG   language code exactly as shown in WhatsApp Manager (default en)

   How it sends: the PDF is uploaded to WhatsApp first, then the
   template message is sent with that file as its document header.

   Never throws. If the template is not approved yet, or the owner has
   no valid mobile number, nothing is sent and the email is not affected.
============================================================ */

const TIMEOUT_MS = 15000;
const templateName = () => String(process.env.WA_TEMPLATE_PLAN_RECEIPT || "hostelnode_plan_receipt").trim();
const templateLang = () => String(process.env.WA_TEMPLATE_PLAN_RECEIPT_LANG || "en").trim();
const enabled = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID && !/^(off|0|false)$/i.test(templateName());
// WA_API_BASE exists for tests only.
const apiBase = () => String(process.env.WA_API_BASE || "https://graph.facebook.com/v19.0").replace(/\/$/, "") + "/" + process.env.WA_PHONE_ID;

function mobileOf(phone) {
  let d = String(phone || "").replace(/\D/g, "").replace(/^00/, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(2);
  if (d.length > 10 && d.startsWith("0")) d = d.slice(1);
  const ten = d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}
// WhatsApp refuses template values with line breaks, tabs or long runs of spaces.
const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || "-";

/** The five values of the template body, in order. */
function receiptValues({ ownerName, planName, amountText, validUntil, receiptNo }) {
  return [tidy(ownerName), tidy(planName), tidy(amountText), tidy(validUntil), tidy(receiptNo)];
}

async function call(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error && data.error.message) || "WhatsApp answered " + res.status);
  return data || {};
}

// The two calls to WhatsApp. Kept separate so tests can replace them.
const live = {
  async uploadPdf(pdf, filename) {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", "application/pdf");
    form.set("file", new Blob([pdf], { type: "application/pdf" }), filename);
    const data = await call(apiBase() + "/media", { method: "POST", headers: { Authorization: "Bearer " + process.env.WA_TOKEN }, body: form });
    if (!data.id) throw new Error("WhatsApp did not return a file id");
    return String(data.id);
  },
  async sendTemplate(to, name, lang, values, mediaId, filename) {
    await call(apiBase() + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name, language: { code: lang },
          components: [
            { type: "header", parameters: [{ type: "document", document: { id: mediaId, filename } }] },
            { type: "body", parameters: values.map(v => ({ type: "text", text: v })) },
          ],
        },
      }),
    });
  },
};

/**
 * Send the receipt PDF. details: { phone, ownerName, planName, amountText, validUntil, receiptNo, pdf (Buffer) }.
 * Returns { sent: true } or { sent: false, why }.
 */
async function sendPlanReceiptWhatsApp(details, api = live) {
  try {
    if (!enabled()) return { sent: false, why: "off" };
    const mobile = mobileOf(details && details.phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    if (!details.pdf || !details.pdf.length) return { sent: false, why: "no receipt file" };
    const filename = "HostelNode-Receipt-" + String(details.receiptNo || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) + ".pdf";
    const mediaId = await api.uploadPdf(details.pdf, filename);
    // Always with the country code: a number that itself begins with 91 must not be sent without it.
    await api.sendTemplate("91" + mobile, templateName(), templateLang(), receiptValues(details), mediaId, filename);
    return { sent: true };
  } catch (err) {
    console.error("Plan receipt WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

module.exports = { sendPlanReceiptWhatsApp, receiptValues, mobileOf, enabled, live };   // live: also used for the Phase 3 settlement slip
