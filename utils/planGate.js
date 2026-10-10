/* ============================================================
   utils/planGate.js  —  Subscriptions Phase 4

   Decides whether an owner's plan allows one specific action.
   Used by Middlewares/planGate.js.

   What is checked (and nothing else):
     Limits   — adding a property, a tenant or a listing
     Features — Reports, Dues & Upcoming, lead status, starting a
                HostelNode chat from Leads, converting a lead

   What is never blocked: viewing or editing anything the owner
   already has, collecting payments, receipts, rooms, floors, the
   dashboard, Messages, Leads list, Billing and Plans.

   This file is identical in both repos. Keep them the same.
============================================================ */

const BillingSettings = require("../models/billingSettings");
const { LIMITS, FEATURES } = require("../config/planFeatures");
const { billingOn, resolveOwnerPlan, ensureTrial } = require("./subscription");

// method + path (as mounted in app.js) → what the plan must allow.
const ID = "[^/]+";
// kind / form: for the three "add" actions — what is being added and the
//   page its form lives on (used to keep the owner's typed form as a draft).
// back: for locked features — the page the owner is returned to, where the
//   upgrade popup opens.
const RULES = [
  { method: "GET",  re: /^\/user\/addnewhostel\/?$/i,                       limit: "maxProperties", kind: "property", form: "/user/addnewhostel" },
  { method: "POST", re: /^\/user\/create-hostel\/?$/i,                      limit: "maxProperties", kind: "property", form: "/user/addnewhostel" },
  { method: "GET",  re: /^\/user\/newmember\/?$/i,                          limit: "maxTenants", kind: "tenant", form: "/user/newmember", featureIfQuery: { enquiry: "convertLead" }, back: "/user/leads" },
  { method: "POST", re: /^\/user\/newmember\/?$/i,                          limit: "maxTenants", kind: "tenant", form: "/user/newmember" },
  { method: "GET",  re: /^\/user\/list-property\/?$/i,                      limit: "maxListings", kind: "listing", form: "/user/list-property" },
  { method: "POST", re: /^\/user\/new-list-property\/?$/i,                  limit: "maxListings", kind: "listing", form: "/user/list-property" },
  { method: "GET",  re: /^\/user\/revenue\/?$/i,                            feature: "reports", back: "/user" },
  { method: "GET",  re: /^\/user\/(deureports|upcomingPayments)\/?$/i,      feature: "duesReport", back: "/user" },
  // Property Operations Phase 5: the new Dues page and the Upcoming tab (Collect and Collected stay open to every plan).
  { method: "GET",  re: /^\/user\/(dues|payments\/upcoming)\/?$/i,          feature: "duesReport", back: "/user/payments" },
  { method: "POST", re: new RegExp(`^/user/enquiries/${ID}/status/?$`, "i"), feature: "leadStatus", back: "/user/leads" },
  { method: "POST", re: new RegExp(`^/user/enquiries/${ID}/chat/?$`, "i"),   feature: "chatReply", back: "/user/leads" },
];

// The path is tidied the way Express itself reads it (repeated slashes,
// %-encoded letters), so an odd spelling of a URL cannot slip past a rule.
function matchRule(method, path) {
  const m = method === "HEAD" ? "GET" : method;
  let p = String(path || "").replace(/\/{2,}/g, "/");
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  p = p.replace(/\/{2,}/g, "/");
  return RULES.find(r => r.method === m && r.re.test(p)) || null;
}

const LIMIT_NOUN = { maxProperties: ["property", "properties"], maxTenants: ["active tenant", "active tenants"], maxListings: ["listing", "listings"] };
const LIMIT_ACTION = { maxProperties: "add another property", maxTenants: "add another tenant", maxListings: "publish another listing" };

async function countUsed(limitKey, ownerId) {
  if (limitKey === "maxProperties") return require("../models/hostel").countDocuments({ owner: ownerId }).maxTimeMS(1500);
  if (limitKey === "maxTenants")    return require("../models/member").countDocuments({ user: ownerId, status: "Active" }).maxTimeMS(1500);
  // Listings saved as hidden drafts (planHold) do not use up the limit.
  // (A held listing that is public anyway is counted, so the limit cannot be dodged.)
  if (limitKey === "maxListings")   return require("../models/listingProperty").countDocuments({ owner: ownerId, $or: [{ planHold: { $ne: true } }, { status: "Approved" }] }).maxTimeMS(1500);
  return 0;
}

// Is enforcement switched on? Looked up at most once a minute for the whole app.
const TTL_MS = Number(process.env.HN_GATE_CACHE_MS) || 60 * 1000;   // env override is for tests only
let cache = { at: 0, on: false };
async function enforcementOn() {
  if (!billingOn()) return false;
  if (Date.now() - cache.at < TTL_MS) return cache.on;
  cache = { at: Date.now(), on: cache.on };
  try { cache = { at: Date.now(), on: !!(await BillingSettings.read()).enforcementEnabled }; }
  catch (err) { console.error("planGate (non-fatal):", err.message); }
  return cache.on;
}

/* Returns null when the action is allowed, or a description of why not:
   { kind:"limit"|"feature", key, title, message, planName, used?, limit? }
   opts.skipLimit: only check the feature part of the rule. */
async function checkGate(ownerId, rule, query, opts) {
  // An owner who has never had a plan gets their free trial first (when trials
  // are on), so nobody is judged on the Default plan before their trial started.
  try { await ensureTrial(ownerId); } catch (err) { console.error("planGate trial (non-fatal):", err.message); }
  const plan = await resolveOwnerPlan(ownerId);
  // No plan record and no Default plan to fall back on: nothing to enforce.
  if (plan.state === "none") return null;

  // e.g. /user/newmember?enquiry=<id> is "convert a lead", not a plain "add tenant".
  let wantFeature = rule.feature || null;
  if (!wantFeature && rule.featureIfQuery && query) {
    for (const k of Object.keys(rule.featureIfQuery)) {
      const v = query[k];
      if (v !== undefined && v !== null && v !== "") { wantFeature = rule.featureIfQuery[k]; break; }
    }
  }
  if (wantFeature && !(plan.features && plan.features[wantFeature] === true)) {
    const f = FEATURES.find(x => x.key === wantFeature);
    return {
      kind: "feature", key: wantFeature, planName: plan.name,
      title: `${f ? f.label : "This feature"} is not part of your plan`,
      message: `You are on the ${plan.name} plan. Upgrade to a plan that includes ${f ? f.label.toLowerCase() : "this feature"}.`,
    };
  }

  if (rule.limit && !(opts && opts.skipLimit)) {
    const raw = plan.limits ? plan.limits[rule.limit] : null;
    if (raw === null || raw === undefined) return null;             // unlimited
    const limit = Number(raw);
    if (!Number.isFinite(limit)) return null;
    const used = await countUsed(rule.limit, ownerId);
    if (used < limit) return null;
    const noun = LIMIT_NOUN[rule.limit] || ["item", "items"];
    const l = LIMITS.find(x => x.key === rule.limit);
    return {
      kind: "limit", key: rule.limit, planName: plan.name, used, limit,
      title: `You have reached your plan's limit`,
      message: `Your ${plan.name} plan allows ${limit} ${limit === 1 ? noun[0] : noun[1]} and you have ${used}. Upgrade to ${LIMIT_ACTION[rule.limit] || "add more"}.`,
      limitLabel: l ? l.label : "",
    };
  }
  return null;
}

module.exports = { RULES, matchRule, enforcementOn, checkGate };
