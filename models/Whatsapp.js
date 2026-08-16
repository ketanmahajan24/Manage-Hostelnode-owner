const axios = require('axios');

// ================= CONFIG =================
const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const BASE_URL    = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;

// ================= LOGGER =================
const log   = (...a) => console.log("🟢", ...a);
const error = (...a) => console.error("🔴", ...a);

// ================= FORMAT NUMBER =================
function formatNumber(phone) {
  const clean = phone.toString().replace(/\D/g, "");
  return clean.startsWith("91") ? clean : `91${clean}`;
}

// ================= API CALL =================
async function callWAAPI(payload) {
  try {
    const res = await axios.post(BASE_URL, payload, {
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type':  'application/json'
      },
      timeout: 15000
    });
    return { success: true, data: res.data };
  } catch (err) {
    const errData = err.response?.data || err.message;
    error("❌ API Error:", JSON.stringify(errData));
    return { success: false, error: errData };
  }
}

// ================= SEND OTP =================
// ================= SEND OTP =================
// Uses approved "Authentication" template: hostelnode_otp
// Meta template body: "{{1}} is your verification code. For your security, do not share this code."
// ⚠️  Both body AND button parameters required
const sendWhatsAppOTP = async (phone, otp) => {
  try {
    const number = formatNumber(phone);
    log("📤 Sending OTP to:", phone);

    const payload = {
      messaging_product: "whatsapp",
      to:                number,
      type:              "template",
      template: {
        name:     "hostelnode_otp",
        language: { code: "en" },
        components: [
          {
            type:       "body",
            parameters: [{ type: "text", text: String(otp) }]
          },
          {
            type:       "button",
            sub_type:   "url",
            index:      "0",
            parameters: [{ type: "text", text: String(otp) }]
          }
        ]
      }
    };

    const result = await callWAAPI(payload);
    if (result.success) log("✅ OTP sent:", {phone, otp}); 
    else               error("❌ OTP failed:", phone);
    return result;

  } catch (err) {
    error("❌ OTP send error:", err.message);
    return { success: false, error: err.message };
  }
};

// ================= SEND OWNER ENQUIRY =================
// Uses approved "Utility" template: hostelnode_enquiry
// Template body: "A new enquiry has been received on HostelNode platform!
//   Student name is {{1}} and contact number is {{2}}. They are interested
//   in {{3}} hostel for {{4}} room type. Their preferred move-in date is {{5}}
//   and their message reads: {{6}}. Please contact the student on WhatsApp to respond."
const sendOwnerEnquiryMessage = async (phone, data) => {
  try {
    const number = formatNumber(phone);
    log("📤 Sending enquiry to owner:", phone);

    const payload = {
      messaging_product: "whatsapp",
      to:                number,
      type:              "template",
      template: {
        name:     "hostelnode_enquiry",
        language: { code: "en" },
        components: [{
          type:       "body",
          parameters: [
            { type: "text", text: data.studentName          },
            { type: "text", text: data.studentPhone         },
            { type: "text", text: data.hostelName           },
            { type: "text", text: data.roomType  || "N/A"   },
            { type: "text", text: data.moveIn    || "N/A"   },
            { type: "text", text: data.message   || "No message" }
          ]
        }]
      }
    };

    const result = await callWAAPI(payload);
    if (result.success) log("✅ Enquiry sent to owner:", phone);
    else               error("❌ Enquiry failed:", phone);
    return result;

  } catch (err) {
    error("❌ Enquiry send error:", err.message);
    return { success: false, error: err.message };
  }
};

// ================= SEND GENERIC MESSAGE =================
// ⚠️  Only works inside 24-hour customer service window
//     (i.e. user ne pehle message kiya ho)
const sendWhatsAppMessage = async (phone, text) => {
  try {
    const number = formatNumber(phone);
    log("📤 Sending message to:", phone);

    const payload = {
      messaging_product: "whatsapp",
      to:                number,
      type:              "text",
      text:              { body: text }
    };

    const result = await callWAAPI(payload);
    if (result.success) log("✅ Message sent:", phone);
    else               error("❌ Message failed:", phone);
    return result.success;

  } catch (err) {
    error("❌ Generic WA send error:", err.message);
    return false;
  }
};

// ================= EXPORT =================
module.exports = {
  sendWhatsAppOTP,
  sendOwnerEnquiryMessage,
  sendWhatsAppMessage
};
// ================= STARTUP HEALTH CHECK =================
(async () => {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/${WA_PHONE_ID}`,
      { 
        headers: { 'Authorization': `Bearer ${WA_TOKEN}` }, 
        timeout: 10000 
      }
    );
    log(`✅ WhatsApp API Connected! Number: ${res.data?.display_phone_number || res.data?.id}`);
  } catch (err) {
    error("❌ WhatsApp API NOT connected:", err.response?.data?.error?.message || err.message);
  }
})();