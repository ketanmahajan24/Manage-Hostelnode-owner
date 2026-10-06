/* ============================================================
   utils/razorpay.js  —  Subscriptions Phase 3 (owner dashboard)

   The only file that talks to Razorpay. Needs no extra package.

   .env:
     RAZORPAY_KEY_ID=rzp_test_xxx          (or rzp_live_xxx)
     RAZORPAY_KEY_SECRET=xxx
     RAZORPAY_WEBHOOK_SECRET=xxx           (the secret you type when adding the webhook)

   Until all three are set, online payment stays off and the Plans
   page keeps its "Request this plan" button.
============================================================ */

const crypto = require("crypto");
const https  = require("https");
const http   = require("http");

const keyId     = () => String(process.env.RAZORPAY_KEY_ID || "").trim();
const keySecret = () => String(process.env.RAZORPAY_KEY_SECRET || "").trim();
const webhookSecret = () => String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();

// All three are needed. The webhook secret is required on purpose: the
// webhook is what activates a plan when an owner pays and then loses the
// page, so payments are not offered without it.
const configured = () => process.env.HN_BILLING !== "0" && !!keyId() && !!keySecret() && !!webhookSecret();
const isTestMode = () => keyId().startsWith("rzp_test_");

// RAZORPAY_API_BASE exists only so automated tests can point at a stand-in.
const apiBase = () => String(process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiBase() + path);
    const data = body ? JSON.stringify(body) : null;
    const req = (url.protocol === "http:" ? http : https).request({
      method, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search,
      auth: `${keyId()}:${keySecret()}`,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      timeout: 15000,
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; if (raw.length > 1e6) req.destroy(new Error("Razorpay response too large")); });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        const msg = (json && json.error && json.error.description) || `Razorpay answered ${res.statusCode}`;
        reject(new Error(msg));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Razorpay did not answer in time")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// amountPaise: whole number of paise. receipt: our own reference (max 40 chars).
function createOrder({ amountPaise, receipt, notes }) {
  return call("POST", "/v1/orders", { amount: amountPaise, currency: "INR", receipt, notes: notes || {} });
}

// Ask Razorpay about one payment (status, amount, order).
const paymentIdOk = id => /^pay_[A-Za-z0-9]{6,40}$/.test(String(id || ""));
function fetchPayment(paymentId) {
  if (!paymentIdOk(paymentId)) return Promise.reject(new Error("bad payment id"));
  return call("GET", "/v1/payments/" + paymentId);
}
// Collect an authorised payment (needed only if your Razorpay account is not on automatic capture).
function capturePayment(paymentId, amountPaise) {
  if (!paymentIdOk(paymentId)) return Promise.reject(new Error("bad payment id"));
  return call("POST", "/v1/payments/" + paymentId + "/capture", { amount: amountPaise, currency: "INR" });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""), "utf8"), y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// What the owner's browser sends back after paying. Proves Razorpay itself
// confirmed this payment for this order.
function validCheckoutSignature({ orderId, paymentId, signature }) {
  if (!keySecret() || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac("sha256", keySecret()).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(expected, signature);
}

// Razorpay's webhook call. rawBody must be the exact bytes received.
function validWebhookSignature(rawBody, signature) {
  if (!webhookSecret() || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", webhookSecret()).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

module.exports = { configured, isTestMode, keyId, webhookSecret, createOrder, fetchPayment, capturePayment, validCheckoutSignature, validWebhookSignature };
