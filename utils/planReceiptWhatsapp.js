/* ============================================================
   utils/planReceiptWhatsapp.js  —  plan payment receipt on WhatsApp

   After an owner pays for a plan, the same details as the receipt
   email are also sent to their WhatsApp number from HostelNode's
   WhatsApp number (the one that sends OTPs).

   WhatsApp only allows this with an APPROVED message template.
   Create it once in Meta WhatsApp Manager:

     Name      hostelnode_plan_receipt        Category  Utility
     Language  English (en)
     Body      Hi {{1}}, we received your payment for the HostelNode {{2}} plan.

               Amount paid: {{3}}
               Valid until: {{4}}
               Receipt no.: {{5}}

               You can download your receipt any time from Billing in your HostelNode dashboard: https://manage.hostelnode.com/user/account/billing

   Optional env:
     WA_TEMPLATE_PLAN_RECEIPT        template name (default hostelnode_plan_receipt); set to "off" to stop sending
     WA_TEMPLATE_PLAN_RECEIPT_LANG   language code exactly as shown in WhatsApp Manager (default en)

   Never throws. If the template is not approved yet, or the owner has
   no valid mobile number, nothing is sent and the email still goes out.
============================================================ */

const templateName = () => String(process.env.WA_TEMPLATE_PLAN_RECEIPT || "hostelnode_plan_receipt").trim();
const templateLang = () => String(process.env.WA_TEMPLATE_PLAN_RECEIPT_LANG || "en").trim();
const enabled = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID && !/^(off|0|false)$/i.test(templateName());

function mobileOf(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}
// WhatsApp refuses template values with line breaks, tabs or long runs of spaces.
const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || "-";

/** The five values of the template, in order. */
function receiptValues({ ownerName, planName, amountText, validUntil, receiptNo }) {
  return [tidy(ownerName), tidy(planName), tidy(amountText), tidy(validUntil), tidy(receiptNo)];
}

/**
 * Send the receipt. `send` is the template sender (utils/leadWhatsapp.js); it can be passed in for tests.
 * Returns { sent: true } or { sent: false, why }.
 */
async function sendPlanReceiptWhatsApp(details, send) {
  try {
    if (!enabled()) return { sent: false, why: "off" };
    const mobile = mobileOf(details && details.phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    const sender = send || require("./leadWhatsapp").sendTemplateMessage;
    // Always with the country code: a number that itself begins with 91 would otherwise be sent without it.
    const r = await sender("91" + mobile, templateName(), receiptValues(details), null, templateLang());
    return r && r.success ? { sent: true } : { sent: false, why: "not accepted by WhatsApp" };
  } catch (err) {
    console.error("Plan receipt WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "error" };
  }
}

module.exports = { sendPlanReceiptWhatsApp, receiptValues, mobileOf, enabled };
