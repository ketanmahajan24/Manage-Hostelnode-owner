/* ============================================================
   utils/cashfreeKyc.js  —  Property Operations Phase 4 (DigiLocker KYC)
   SHARED: identical in the owner dashboard and hostelnode.com.

   Cashfree Secure ID — DigiLocker (v2):
     POST /verification/digilocker                     make a DigiLocker link (valid 10 minutes)
     GET  /verification/digilocker?verification_id=    status: PENDING, AUTHENTICATED, EXPIRED, CONSENT_DENIED
     GET  /verification/digilocker/document/AADHAAR?verification_id=   the Aadhaar details

   .env (owner dashboard AND hostelnode.com):
     CASHFREE_KYC_CLIENT_ID, CASHFREE_KYC_CLIENT_SECRET   from Cashfree Merchant Dashboard → Secure ID → Developers
     CASHFREE_KYC_ENV=production                          leave out for sandbox (test) keys
   Cashfree also needs ONE of these (their "2FA"):
     • your servers' IP addresses whitelisted in the Cashfree dashboard, or
     • CASHFREE_KYC_PUBLIC_KEY_PATH=/path/to/cashfree_public_key.pem   (the public key downloaded there)
   CASHFREE_KYC_API_BASE exists for tests only.
============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const TIMEOUT_MS = 15000;

const clientId = () => String(process.env.CASHFREE_KYC_CLIENT_ID || "").trim();
const clientSecret = () => String(process.env.CASHFREE_KYC_CLIENT_SECRET || "").trim();
const isLive = () => String(process.env.CASHFREE_KYC_ENV || "").trim().toLowerCase() === "production";
const configured = () => !!(clientId() && clientSecret());
const mode = () => (configured() ? (isLive() ? "live" : "test") : "off");
const base = () => String(process.env.CASHFREE_KYC_API_BASE || (isLive() ? "https://api.cashfree.com/verification" : "https://sandbox.cashfree.com/verification")).replace(/\/$/, "");

let keyCache = "";
// The public key (if one is set). A key that is set but cannot be read stops the call with a
// clear error, instead of the request going out unsigned (Cashfree would refuse it anyway).
function publicKey() {
  if (keyCache) return keyCache;
  let k = String(process.env.CASHFREE_KYC_PUBLIC_KEY || "").replace(/\\n/g, "\n").trim();
  const p = String(process.env.CASHFREE_KYC_PUBLIC_KEY_PATH || "").trim();
  if (!k && p) {
    try { k = fs.readFileSync(p, "utf8").trim(); }
    catch (e) { throw new CashfreeError("The Cashfree public key file could not be read (CASHFREE_KYC_PUBLIC_KEY_PATH).", 0, "public_key_unreadable"); }
  }
  keyCache = k;
  return k;
}
// x-cf-signature: "<clientId>.<unix seconds>" encrypted with Cashfree's public key (RSA-OAEP, SHA-1), base64.
function signature() {
  const k = publicKey();
  if (!k) return "";
  return crypto.publicEncrypt({ key: k, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(`${clientId()}.${Math.floor(Date.now() / 1000)}`)).toString("base64");
}

class CashfreeError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function call(method, path, body) {
  if (!configured()) throw new CashfreeError("DigiLocker KYC is not set up yet.", 0, "not_configured");
  const headers = { "x-client-id": clientId(), "x-client-secret": clientSecret(), Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const sig = signature();
  if (sig) headers["x-cf-signature"] = sig;
  let res;
  try {
    res = await fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new CashfreeError("Could not reach Cashfree. Please try again.", 0, "network");
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status >= 400) throw new CashfreeError((data && data.message) || `Cashfree answered ${res.status}`, res.status, (data && (data.code || data.type)) || "");
  return { status: res.status, data: data || {} };
}

const q = encodeURIComponent;
module.exports = {
  configured, mode, CashfreeError,
  /** A DigiLocker link for Aadhaar. redirectUrl must start with https (Cashfree's rule). */
  createUrl: ({ verificationId, redirectUrl }) => call("POST", "/digilocker", {
    verification_id: verificationId, document_requested: ["AADHAAR"], redirect_url: redirectUrl, user_flow: "signup",
  }),
  status: verificationId => call("GET", `/digilocker?verification_id=${q(verificationId)}`),
  aadhaar: verificationId => call("GET", `/digilocker/document/AADHAAR?verification_id=${q(verificationId)}`),
};
