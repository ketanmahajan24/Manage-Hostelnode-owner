/* ============================================================
   utils/planView.js  —  Subscriptions Phase 2 (owner dashboard)

   Prepares what the Billing and Plans pages show about the
   logged-in owner's plan. Read-only. Returns null if subscriptions
   are switched off or anything fails, and the pages then render
   exactly as they did before.
============================================================ */

const Plan = require("../models/plan");
const { LIMITS, FEATURES } = require("../config/planFeatures");
const { billingOn, resolveOwnerPlan, ownerUsage } = require("./subscription");

const day = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const LIMIT_WORDS = {
  maxProperties: n => (n === null ? "Unlimited properties" : n === 1 ? "1 property" : `Up to ${n} properties`),
  maxTenants:    n => (n === null ? "Unlimited tenants" : `Up to ${plural(n, "active tenant")}`),
  maxListings:   n => (n === null ? "Unlimited listings on hostelnode.com" : `${plural(n, "listing")} on hostelnode.com`),
};
const USAGE_LABEL = { maxProperties: "Properties", maxTenants: "Active tenants", maxListings: "Listings" };

function limitLine(key, value) {
  const v = value === null || value === undefined ? null : Number(value);
  return LIMIT_WORDS[key] ? LIMIT_WORDS[key](v) : "";
}

// Plans the owner can see right now (visible, not archived, offer not over).
function visiblePlans(now = new Date()) {
  return Plan.find({
    role: "normal", isVisible: true, archivedAt: null,
    $or: [{ offerEndsAt: null }, { offerEndsAt: { $gt: now } }],
  }).sort({ sortOrder: 1, createdAt: 1 }).lean();
}

function planCard(p, currentPlanId) {
  const d = p.duration || {};
  return {
    id: String(p._id),
    name: p.name, description: p.description || "", badge: p.badge || "",
    price: Number(p.price) || 0,
    strikePrice: p.strikePrice ? Number(p.strikePrice) : null,
    per: d.value === 1 ? `per ${d.unit}` : `for ${plural(d.value, d.unit)}`,
    offerEnds: p.offerEndsAt ? day(p.offerEndsAt) : "",
    // "about ₹125 a month" for plans longer than one month (a plain division, shown as a helper line)
    perMonth: (() => {
      const months = d.unit === "year" ? d.value * 12 : d.unit === "month" ? d.value : 0;
      return months > 1 && Number(p.price) > 0 ? Math.round(Number(p.price) / months) : 0;
    })(),
    limitLines: LIMITS.map(l => limitLine(l.key, p.limits ? p.limits[l.key] : null)).filter(Boolean),
    features: FEATURES.map(f => ({ label: f.label, on: !!(p.features && p.features[f.key]) })),
    points: (p.displayPoints || []).slice(0, 10),
    isCurrent: !!currentPlanId && String(p._id) === String(currentPlanId),
    // for the upgrade popup: which plans lift a given limit / include a given feature
    limits: Object.fromEntries(LIMITS.map(l => [l.key, p.limits && p.limits[l.key] !== undefined ? p.limits[l.key] : null])),
    featureKeys: FEATURES.filter(f => p.features && p.features[f.key]).map(f => f.key),
  };
}

// Never let plan lookups hold a page: after 2 seconds the page renders without the plan card.
async function loadPlanInfo(ownerId, now = new Date()) {
  if (!billingOn()) return null;
  let timer;
  const result = await Promise.race([
    buildPlanInfo(ownerId, now),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
  ]);
  clearTimeout(timer);
  return result;
}

async function buildPlanInfo(ownerId, now) {
  try {
    const [current, usage, plans] = await Promise.all([
      resolveOwnerPlan(ownerId, now), ownerUsage(ownerId), visiblePlans(now),
    ]);

    let status, line, tone;
    const until = current.expiresAt ? day(current.expiresAt) : "";
    if (current.state === "trial") {
      status = "FREE TRIAL"; tone = "is-ok";
      line = `${plural(current.daysLeft, "day")} left. Your trial ends on ${until}.`;
    } else if (current.state === "active") {
      status = "ACTIVE"; tone = "is-ok";
      line = current.expiresAt ? `Valid until ${until} (${plural(current.daysLeft, "day")} left).` : "This plan does not expire.";
    } else if (current.state === "grace") {
      status = "EXPIRED"; tone = "is-warn";
      line = `This plan expired on ${until}. You keep it until ${day(current.graceEndsAt)}.`;
    } else if (current.state === "default") {
      status = "FREE PLAN"; tone = "is-warn";
      line = current.expired && current.expired.expiresAt
        ? `Your ${current.expired.name} plan ended on ${day(current.expired.expiresAt)}.`
        : "You are on the free plan.";
    } else {
      status = "NO PLAN"; tone = "is-warn";
      line = "You have not chosen a plan yet.";
    }

    const usageRows = LIMITS.map(l => {
      const raw = current.limits ? current.limits[l.key] : null;
      const limit = raw === null || raw === undefined ? null : Number(raw);
      const used = Number(usage[l.key]) || 0;
      return {
        label: USAGE_LABEL[l.key] || l.label, used, limit,
        percent: limit === null ? 0 : limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.round((used / limit) * 100)),
        over: limit !== null && used > limit,
        full: limit !== null && used === limit,   // Phase 4: at the limit, cannot add more
      };
    });

    let paidSeen = 0;
    return {
      state: current.state, name: current.name, status, tone, line,
      usageRows,
      // "No plan" with nothing to choose from: nothing useful to show yet.
      show: current.state !== "none" || plans.length > 0,
      // for the look of the Billing page: which colour the plan card takes, and how far through the period we are
      look: { trial: "blue", active: "green", grace: "amber", default: "slate", none: "slate" }[current.state] || "slate",
      daysLeft: current.daysLeft === undefined ? null : current.daysLeft,
      // what the owner's own plan includes, in plain words
      included: LIMITS.map(l => limitLine(l.key, current.limits ? current.limits[l.key] : null)).filter(Boolean)
        .concat(FEATURES.filter(f => current.features && current.features[f.key]).map(f => f.label)),
      notIncluded: FEATURES.filter(f => !(current.features && current.features[f.key])).map(f => f.label),
      // a plan the owner paid for (or was given), still running: gets the richer look
      isPaid: current.state === "active" && !!current.subscription && Number(current.subscription.snapshot && current.subscription.snapshot.price) > 0,
      startedOn: current.startsAt ? day(current.startsAt) : "",
      endsOn: current.state === "grace" ? day(current.graceEndsAt) : current.expiresAt ? day(current.expiresAt) : "",
      endsLabel: current.state === "trial" ? "Trial ends" : current.state === "grace" ? "Kept until" : "Valid until",
      paidPrice: current.subscription && current.subscription.snapshot ? Number(current.subscription.snapshot.price) || 0 : 0,
      timePercent: (current.startsAt && current.expiresAt && new Date(current.expiresAt) > new Date(current.startsAt))
        ? Math.max(0, Math.min(100, Math.round(((now - new Date(current.startsAt)) / (new Date(current.expiresAt) - new Date(current.startsAt))) * 100)))
        : null,
      plans: plans.map(p => {
        const card = planCard(p, current.planId);
        // each paid plan card gets its own colour; a free plan stays quiet
        card.theme = card.price ? ["green", "blue", "violet", "amber"][paidSeen++ % 4] : "slate";
        // Let the owner ask to renew the plan they are on once it is close to (or past) its end.
        card.canRenew = card.isCurrent && (current.state === "grace" || (current.daysLeft !== null && current.daysLeft <= 7));
        return card;
      }),
    };
  } catch (err) {
    console.error("Plan info (non-fatal):", err.message);
    return null;
  }
}

module.exports = { loadPlanInfo };
