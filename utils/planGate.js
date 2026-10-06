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
const RULES = [
  { method: "GET",  re: /^\/user\/addnewhostel\/?$/i,                       limit: "maxProperties" },
  { method: "POST", re: /^\/user\/create-hostel\/?$/i,                      limit: "maxProperties" },
  { method: "GET",  re: /^\/user\/newmember\/?$/i,                          limit: "maxTenants", featureIfQuery: { enquiry: "convertLead" } },
  { method: "POST", re: /^\/user\/newmember\/?$/i,                          limit: "maxTenants" },
  { method: "GET",  re: /^\/user\/list-property\/?$/i,                      limit: "maxListings" },
  { method: "POST", re: /^\/user\/new-list-property\/?$/i,                  limit: "maxListings" },
  { method: "GET",  re: /^\/user\/revenue\/?$/i,                            feature: "reports" },
  { method: "GET",  re: /^\/user\/(deureports|upcomingPayments)\/?$/i,      feature: "duesReport" },
  { method: "POST", re: new RegExp(`^/user/enquiries/${ID}/status/?$`, "i"), feature: "leadStatus" },
  { method: "POST", re: new RegExp(`^/user/enquiries/${ID}/chat/?$`, "i"),   feature: "chatReply" },
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
  if (limitKey === "maxListings")   return require("../models/listingProperty").countDocuments({ owner: ownerId }).maxTimeMS(1500);
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
   { kind:"limit"|"feature", title, message, planName } */
async function checkGate(ownerId, rule, query) {
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
      kind: "feature", planName: plan.name,
      title: `${f ? f.label : "This feature"} is not part of your plan`,
      message: `You are on the ${plan.name} plan. Upgrade to a plan that includes ${f ? f.label.toLowerCase() : "this feature"}.`,
    };
  }

  if (rule.limit) {
    const raw = plan.limits ? plan.limits[rule.limit] : null;
    if (raw === null || raw === undefined) return null;             // unlimited
    const limit = Number(raw);
    if (!Number.isFinite(limit)) return null;
    const used = await countUsed(rule.limit, ownerId);
    if (used < limit) return null;
    const noun = LIMIT_NOUN[rule.limit] || ["item", "items"];
    const l = LIMITS.find(x => x.key === rule.limit);
    return {
      kind: "limit", planName: plan.name,
      title: `You have reached your plan's limit`,
      message: `Your ${plan.name} plan allows ${limit} ${limit === 1 ? noun[0] : noun[1]} and you have ${used}. Upgrade to ${LIMIT_ACTION[rule.limit] || "add more"}.`,
      limitLabel: l ? l.label : "",
    };
  }
  return null;
}

module.exports = { RULES, matchRule, enforcementOn, checkGate };
