/* ============================================================
   utils/payouts.js  —  Property Operations Phase 6: owner bank payouts
   (Razorpay Route linked accounts). Owner dashboard only.

   An owner's bank account is registered with Razorpay as a Route
   "linked account" in four steps (each saved as soon as it is done,
   so a retry carries on where it stopped):
     1. POST  /v2/accounts                          the business (name, type, PAN, address)
     2. POST  /v2/accounts/:id/stakeholders         the person (name, email, PAN)
     3. POST  /v2/accounts/:id/products             ask for Route (terms accepted)
     4. PATCH /v2/accounts/:id/products/:pid        the bank account for payouts
   Razorpay then checks it; the status comes back on each call, from the
   webhook (account / product events) and from refresh() (page views,
   every few hours).

   Never kept: the full bank account number and the PAN (sent to Razorpay only).

   .env (owner dashboard):
     RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET   the same keys as plan payments
     HN_ROUTE_CATEGORY=housing               Razorpay business category (optional)
     HN_ROUTE_SUBCATEGORY=space_rental       Razorpay business sub-category (optional)
     HN_PAYOUTS=off                          hides "Receive payments" (switch)
============================================================ */

const https = require("https");
const http = require("http");
const rzp = require("./razorpay");
const PayoutAccount = require("../models/payoutAccount");
const { withLocks } = require("./locks");

const keyId = () => String(process.env.RAZORPAY_KEY_ID || "").trim();
const keySecret = () => String(process.env.RAZORPAY_KEY_SECRET || "").trim();
const switchedOn = () => !/^(off|0|false|no)$/i.test(String(process.env.HN_PAYOUTS || "").trim());
/** The page is shown (switch on). */
const enabled = () => switchedOn();
/** Razorpay keys are set, so owners can register. */
const ready = () => switchedOn() && !!keyId() && !!keySecret();
const mode = () => (!keyId() ? "off" : keyId().startsWith("rzp_live_") ? "live" : "test");

const TYPES = {
  individual:      { label: "Individual", pan: /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/, panHint: "a personal PAN (4th letter P)" },
  proprietorship:  { label: "Proprietor", pan: /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/, panHint: "the proprietor's personal PAN (4th letter P)" },
  partnership:     { label: "Partnership", pan: /^[A-Z]{3}F[A-Z]\d{4}[A-Z]$/, panHint: "the firm's PAN (4th letter F)" },
  private_limited: { label: "Company", pan: /^[A-Z]{3}C[A-Z]\d{4}[A-Z]$/, panHint: "the company's PAN (4th letter C)" },
  llp:             { label: "LLP", pan: /^[A-Z]{3}F[A-Z]\d{4}[A-Z]$/, panHint: "the LLP's PAN (4th letter F)" },
};
const STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];
const STATUS = {
  draft:           { label: "Not set up", tone: "slate" },
  under_review:    { label: "Under review", tone: "blue" },
  active:          { label: "Active", tone: "ok" },
  needs_attention: { label: "Needs attention", tone: "warn" },
  suspended:       { label: "Suspended", tone: "bad" },
};

const clean = (s, max = 100) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "");
const NAME = /^[A-Za-z][A-Za-z .&'()-]{2,}$/;                  // a person's name
const LEGAL = /^[A-Za-z0-9][A-Za-z0-9 .,&'()\/-]{2,}$/;        // a business or bank-account name ("M/s A1 Hostels")
/** A mobile number as typed: +91 / 0 in front are fine; anything else must be exactly 10 digits. */
function mobileOf(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}
/** Razorpay's error text, without anything that looks like an account number, PAN or email (it is stored and shown). */
const redact = s => String(s || "")
  .replace(/[A-Z]{5}\d{4}[A-Z]/gi, "[PAN]").replace(/\d{6,20}/g, m => "••" + m.slice(-4)).replace(/[^\s@<>]+@[^\s@<>]+/g, "[email]").slice(0, 300);

/**
 * Check what the owner typed. bankOnly: only the bank part (changing the bank account).
 * Returns { values, errors: { field: message } }.
 */
function validate(b, { bankOnly = false } = {}) {
  const v = {}, e = {};
  v.accountNumber = String(b.accountNumber || "").replace(/\s/g, "");
  v.accountNumber2 = String(b.accountNumber2 || "").replace(/\s/g, "");
  v.ifsc = String(b.ifsc || "").trim().toUpperCase();
  v.beneficiaryName = clean(b.beneficiaryName, 120);
  if (!/^\d{9,18}$/.test(v.accountNumber)) e.accountNumber = "Enter the bank account number (9 to 18 digits).";
  else if (v.accountNumber !== v.accountNumber2) e.accountNumber2 = "The two account numbers are not the same.";
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifsc)) e.ifsc = "Enter the 11-character IFSC, for example HDFC0000317.";
  if (!LEGAL.test(v.beneficiaryName)) e.beneficiaryName = "Enter the account holder's name as the bank has it.";
  if (b.tnc !== "1") e.tnc = "Please agree to Razorpay's terms to receive payouts.";
  if (bankOnly) return { values: v, errors: e };

  v.businessType = TYPES[b.businessType] ? b.businessType : "";
  v.legalName = clean(b.legalName, 200);
  v.pan = String(b.pan || "").trim().toUpperCase();
  v.contactName = clean(b.contactName, 120);
  v.email = clean(b.email, 120).toLowerCase();
  v.phone = mobileOf(b.phone);
  v.street = clean(b.street, 100);
  v.city = clean(b.city, 60);
  v.state = STATES.includes(b.state) ? b.state : "";
  v.pin = String(b.pin || "").trim();
  if (!v.businessType) e.businessType = "Choose the business type.";
  if (v.legalName.length < 4 || !LEGAL.test(v.legalName)) e.legalName = "Enter the legal name exactly as on the PAN.";
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v.pan)) e.pan = "Enter the 10-character PAN, for example ABCPM1234K.";
  else if (v.businessType && !TYPES[v.businessType].pan.test(v.pan)) e.pan = `For "${TYPES[v.businessType].label}", use ${TYPES[v.businessType].panHint}.`;
  if (!NAME.test(v.contactName)) e.contactName = "Enter your name.";
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(v.email)) e.email = "Enter a working email address.";
  if (!/^[6-9]\d{9}$/.test(v.phone)) e.phone = "Enter a 10-digit mobile number.";
  if (v.street.length < 3) e.street = "Enter the address.";
  if (v.city.length < 2) e.city = "Enter the city.";
  if (!v.state) e.state = "Choose the state.";
  if (!/^[1-9]\d{5}$/.test(v.pin)) e.pin = "Enter the 6-digit PIN code.";
  return { values: v, errors: e };
}

/* ── IFSC → bank and branch (Razorpay's free IFSC service) ── */
const ifscCache = new Map();
function ifscLookup(code) {
  const c = String(code || "").toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(c)) return Promise.resolve(null);
  if (ifscCache.has(c)) return Promise.resolve(ifscCache.get(c));
  const base = String(process.env.IFSC_API_BASE || "https://ifsc.razorpay.com").replace(/\/$/, "");
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { finish(null); try { req && req.destroy(); } catch { /* gone */ } }, 6000);   // never waits longer than this
    let url, req;
    try { url = new URL(base + "/" + c); } catch { return finish(null); }
    req = (url.protocol === "http:" ? http : https).get(url, { timeout: 6000 }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", d => { raw += d; if (raw.length > 50000) { finish(null); req.destroy(); } });
      res.on("error", () => finish(null));
      res.on("aborted", () => finish(null));
      res.on("close", () => finish(null));   // (after "end" this changes nothing)
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(raw); } catch { /* not JSON */ }
        const out = res.statusCode === 200 && j && j.BANK ? { bank: String(j.BANK).slice(0, 80), branch: String(j.BRANCH || "").slice(0, 80), city: String(j.CITY || j.DISTRICT || "").slice(0, 60) } : null;
        if (out || res.statusCode === 404) { if (ifscCache.size > 2000) ifscCache.clear(); ifscCache.set(c, out); }
        finish(out);
      });
    });
    req.on("timeout", () => { finish(null); req.destroy(); });
    req.on("error", () => finish(null));
  });
}

/* ── Razorpay status → HostelNode status ─────────────────── */
const FIELD_TEXT = [
  [/^settlements\.(account_number|ifsc|ifsc_code)/, "The bank account could not be verified. Check the account number and IFSC."],
  [/^settlements\.beneficiary_name/, "The account holder's name could not be matched. Use the name exactly as the bank has it."],
  [/pan/i, "The PAN could not be verified. Check it matches the legal name."],
  [/name/i, "The name could not be matched with the PAN or the bank account."],
  [/address|postal_code|state|city/i, "The address needs to be completed."],
  [/email|phone/i, "The contact email or mobile needs to be checked."],
];
function reasonOf(r) {
  const f = String((r && r.field_reference) || "");
  for (const [re, text] of FIELD_TEXT) if (re.test(f)) return text;
  return "Razorpay needs more details" + (f ? ` (${f})` : "") + ".";
}
function statusOf(activation, accountStatus) {
  if (String(accountStatus || "") === "suspended" || activation === "suspended") return "suspended";
  if (activation === "activated") return "active";
  if (activation === "needs_clarification") return "needs_attention";
  if (activation === "under_review" || activation === "requested") return "under_review";
  return "under_review";
}
/** Apply what Razorpay said about the product (and account) to our record. */
async function applyProduct(rec, product, accountStatus, by = "Razorpay") {
  const activation = String((product && product.activation_status) || "");
  const status = statusOf(activation, accountStatus);
  const reqs = (product && Array.isArray(product.requirements) ? product.requirements : [])
    .filter(r => r && r.status !== "resolved")
    .map(r => ({ field: String(r.field_reference || "").slice(0, 80), reason: reasonOf(r) }));
  // (one line per different reason)
  const requirements = reqs.filter((r, i) => reqs.findIndex(x => x.reason === r.reason) === i).slice(0, 10);
  const set = { razorpayStatus: activation || rec.razorpayStatus, status, requirements: status === "needs_attention" ? requirements : [], lastCheckedAt: new Date(), lastError: "" };
  if (status === "active" && !rec.activatedAt) set.activatedAt = new Date();
  const update = { $set: set };
  if (status !== rec.status) update.$push = { history: { $each: [{ at: new Date(), text: STATUS[status].label + (status === "needs_attention" && requirements[0] ? ": " + requirements[0].reason : ""), by }], $slice: -50 } };
  await PayoutAccount.updateOne({ _id: rec._id }, update);
  return Object.assign({}, rec, set);
}

async function locked(key, fn) {
  for (let i = 0; i < 30; i++) {
    const r = await withLocks([key], fn);
    if (!r.busy) return r.value;
    await new Promise(z => setTimeout(z, 200));
  }
  const e = new Error("Someone else is saving these details right now. Please try again."); e.code = "busy"; throw e;
}

/**
 * Submit (or fix, or change the bank account of) an owner's payout details.
 * values: from validate(). bankOnly: only the bank account (changing it).
 * Returns the saved record. Throws an Error with a message for the owner when Razorpay refuses.
 */
async function submit(ownerId, values, { bankOnly = false, byName = "owner" } = {}) {
  if (!ready()) { const e = new Error("Online payouts are not switched on yet."); e.code = "not_ready"; throw e; }
  return locked(`payout:${ownerId}`, async () => {
    let rec = await PayoutAccount.findOne({ owner: ownerId }).lean();
    if (!rec && bankOnly) { const e = new Error("Fill in all your details first."); e.code = "not_set_up"; throw e; }
    if (!rec) rec = (await PayoutAccount.create({ owner: ownerId })).toObject();
    // Made with test keys, now live (or the other way round): Razorpay needs a new linked account.
    if (rec.accountId && rec.mode && rec.mode !== mode()) {
      await PayoutAccount.updateOne({ _id: rec._id }, { $set: { accountId: "", stakeholderId: "", productId: "", mode: "", status: "draft", razorpayStatus: "", requirements: [] } });
      rec = await PayoutAccount.findById(rec._id).lean();
    }
    if (bankOnly && (!rec.accountId || !rec.productId)) { const e = new Error("Fill in all your details first."); e.code = "not_set_up"; throw e; }
    // An account id linked by HostelNode support (an earlier try whose answer was lost): used only
    // if Razorpay says it is this owner's (we put the owner's id in its notes when we made it).
    if (rec.accountId && !rec.mode) {
      let acc = null;
      try { acc = await rzp.call("GET", `/v2/accounts/${rec.accountId}`); } catch { acc = null; }
      const noteOwner = acc && acc.notes && (acc.notes.hostelnode_owner || acc.notes.hostelnode_owner_id);
      if (!acc || String(noteOwner || "") !== String(ownerId)) {
        await PayoutAccount.updateOne({ _id: rec._id }, { $set: { lastError: "linked account: not this owner's (or not found) — check the id" } });
        const e = new Error("The Razorpay account linked for you could not be confirmed as yours. Please contact support@hostelnode.com."); e.code = "razorpay"; throw e;
      }
      await PayoutAccount.updateOne({ _id: rec._id }, { $set: { mode: mode() } });
      rec.mode = mode();
    }
    const save = set => PayoutAccount.updateOne({ _id: rec._id }, { $set: set }).then(() => Object.assign(rec, set));
    const fail = async (err, step) => {
      const msg = redact(err && err.message || "Razorpay could not be reached");
      await PayoutAccount.updateOne({ _id: rec._id }, { $set: { lastError: `${step}: ${msg}` } });
      // An earlier try that Razorpay finished but we never heard back from (a lost connection): support links it.
      const text = /already exists/i.test(msg)
        ? "Razorpay already has a payout account for these details, probably from an earlier try that did not finish. Please contact support@hostelnode.com and we will link it for you."
        : err && err.status ? `Razorpay did not accept the details: ${msg}` : "Razorpay could not be reached. Please try again in a minute.";
      const e = new Error(text); e.code = "razorpay"; throw e;
    };

    if (!bankOnly) {
      const v = values;
      // Once Razorpay has the account, its email and business type stay as they are (Razorpay does not change them).
      if (rec.accountId) { v.email = rec.email || v.email; v.businessType = rec.businessType || v.businessType; }
      const address = { street1: v.street, city: v.city, state: v.state.toUpperCase(), postal_code: v.pin, country: "IN" };
      const account = {
        email: v.email, phone: v.phone, legal_business_name: v.legalName, business_type: v.businessType, contact_name: v.contactName,
        profile: { category: process.env.HN_ROUTE_CATEGORY || "housing", subcategory: process.env.HN_ROUTE_SUBCATEGORY || "space_rental", addresses: { registered: address } },
        ...(v.businessType === "individual" ? {} : { legal_info: { pan: v.pan } }),
      };
      const mine = { businessType: v.businessType, legalName: v.legalName, contactName: v.contactName, email: v.email, phone: v.phone, panLast4: v.pan.slice(-4), street: v.street, city: v.city, state: v.state, pin: v.pin };
      try {
        if (!rec.accountId) {
          const a = await rzp.call("POST", "/v2/accounts", Object.assign({ type: "route" }, account, { notes: { hostelnode_owner: String(ownerId) } }));
          await save(Object.assign({ accountId: String(a.id), mode: mode() }, mine));
        } else {
          const { email, business_type, ...changeable } = account;   // (email and type cannot be changed once made)
          await rzp.call("PATCH", `/v2/accounts/${rec.accountId}`, changeable);
          await save(mine);
        }
      } catch (err) { return fail(err, "account"); }
      const person = { name: v.contactName, email: v.email, phone: { primary: v.phone }, ...(/^[A-Z]{3}P/.test(v.pan) ? { kyc: { pan: v.pan } } : {}) };   // a personal PAN belongs to the person
      try {
        if (!rec.stakeholderId) {
          // (One made by an earlier try whose answer was lost is used, not a second one.)
          const had = await rzp.call("GET", `/v2/accounts/${rec.accountId}/stakeholders`).catch(() => null);
          const first = had && Array.isArray(had.items) && had.items.find(x => x && /^sth_/.test(String(x.id)));
          const s = first || await rzp.call("POST", `/v2/accounts/${rec.accountId}/stakeholders`, person);
          await save({ stakeholderId: String(s.id) });
          if (first) await rzp.call("PATCH", `/v2/accounts/${rec.accountId}/stakeholders/${s.id}`, person);
        } else {
          await rzp.call("PATCH", `/v2/accounts/${rec.accountId}/stakeholders/${rec.stakeholderId}`, person);
        }
      } catch (err) { return fail(err, "stakeholder"); }
      try {
        if (!rec.productId) {
          const p = await rzp.call("POST", `/v2/accounts/${rec.accountId}/products`, { product_name: "route", tnc_accepted: true });
          await save({ productId: String(p.id) });
        }
      } catch (err) { return fail(err, "product"); }
    }
    const bank = await ifscLookup(values.ifsc);   // (before the bank call: never left waiting after it)
    let product;
    try {
      product = await rzp.call("PATCH", `/v2/accounts/${rec.accountId}/products/${rec.productId}`, {
        settlements: { account_number: values.accountNumber, ifsc_code: values.ifsc, beneficiary_name: values.beneficiaryName }, tnc_accepted: true,
      });
    } catch (err) { return fail(err, "bank account"); }
    await PayoutAccount.updateOne({ _id: rec._id }, {
      $set: { bankLast4: values.accountNumber.slice(-4), ifsc: values.ifsc, bankName: bank ? bank.bank : "", bankBranch: bank ? bank.branch : "", beneficiaryName: values.beneficiaryName, submittedAt: new Date(), lastError: "" },
      $push: { history: { $each: [{ at: new Date(), text: bankOnly ? `Bank account changed to ••${values.accountNumber.slice(-4)}` : (rec.submittedAt ? "Details updated" : "Submitted"), by: byName }], $slice: -50 } },
    });
    rec = await PayoutAccount.findById(rec._id).lean();
    // A changed bank account is checked again: until Razorpay says otherwise, it is under review.
    if (bankOnly && product && product.activation_status === "activated") product = Object.assign({}, product, { activation_status: "under_review" });
    return applyProduct(rec, product, null, "Razorpay");
  });
}

/** Ask Razorpay for the latest status (at most once a minute per owner unless force). */
async function refresh(rec, { force = false, wait = false } = {}) {
  if (!rec || !rec.accountId || !rec.productId || !ready()) return rec;
  if (rec.mode !== mode()) return rec;   // (made with other keys, or linked by support and not confirmed yet: filled in again first)
  if (!force && rec.lastCheckedAt && Date.now() - new Date(rec.lastCheckedAt) < 60e3) return rec;
  try {
    // Under the same lock as submit(): a check never writes an older answer over a change being saved.
    const once = async () => {
      const now = await PayoutAccount.findById(rec._id).lean();
      if (!now || !now.accountId || !now.productId) return now || rec;
      await PayoutAccount.updateOne({ _id: now._id }, { $set: { lastCheckedAt: new Date() } });
      const [product, account] = await Promise.all([
        rzp.call("GET", `/v2/accounts/${now.accountId}/products/${now.productId}`),
        rzp.call("GET", `/v2/accounts/${now.accountId}`).catch(() => null),
      ]);
      return applyProduct(now, product, account && account.status);
    };
    // (A page view does not wait for a submit being saved; the webhook does, so its news is not lost.)
    if (wait) return await locked(`payout:${rec.owner}`, once);
    const r = await withLocks([`payout:${rec.owner}`], once);
    return r.busy ? rec : r.value;   // (being saved right now: shown as it is)
  } catch (err) {
    console.error("Payout status check (non-fatal):", redact(err.message));
    return rec;
  }
}
/** For the webhook: refresh the owner whose linked account this is. */
async function refreshAccount(accountId) {
  if (!/^acc_[A-Za-z0-9]{6,30}$/.test(String(accountId || ""))) return null;
  const rec = await PayoutAccount.findOne({ accountId }).lean();
  return rec ? refresh(rec, { force: true, wait: true }) : null;
}
/** Every few hours: accounts still being checked. */
async function refreshPending() {
  if (!ready()) return 0;
  const list = await PayoutAccount.find({ status: { $in: ["under_review", "needs_attention"] }, accountId: { $ne: "" }, productId: { $ne: "" } }).limit(500).lean();
  for (const rec of list) await refresh(rec, { force: true });
  return list.length;
}

/** Can this owner receive online rent now? (Phase 7 uses this.) */
const canReceive = rec => !!(rec && rec.status === "active" && ready() && rec.mode === mode());

/** Made with the other kind of Razorpay keys (test ↔ live): to be filled in again. */
const staleMode = rec => !!(rec && rec.accountId && rec.mode && ready() && rec.mode !== mode());

module.exports = { enabled, ready, mode, TYPES, STATES, STATUS, validate, ifscLookup, submit, refresh, refreshAccount, refreshPending, canReceive, statusOf, reasonOf, staleMode, redact };
