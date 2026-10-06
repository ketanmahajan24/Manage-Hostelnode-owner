/* ============================================================
   config/planFeatures.js  —  Subscriptions Phase 1

   The fixed list of things a plan can limit or switch on.
   The admin Plans form is built from this list, and (from Phase 4)
   the owner dashboard reads the same keys to decide what to lock.

   To add a new lockable item later: add one line here, in BOTH
   repos (hostelnode.com and the owner dashboard). Existing plans
   simply have it "unlimited" / "off" until you edit them.
============================================================ */

// Number limits. Empty in the form = unlimited (stored as null).
const LIMITS = [
  { key: "maxProperties", label: "Properties managed",          help: "How many PGs/hostels the owner can manage." },
  { key: "maxTenants",    label: "Active tenants",              help: "Across all of the owner's properties." },
  { key: "maxListings",   label: "Listings on hostelnode.com",  help: "How many listings the owner can publish." },
];

// On/off features.
const FEATURES = [
  { key: "reports",     label: "Reports & revenue",          help: "The Reports / Revenue page." },
  { key: "duesReport",  label: "Dues & upcoming payments",   help: "Dues report and Upcoming payments pages." },
  { key: "leadStatus",  label: "Lead status tracking",       help: "Mark enquiries New / Contacted / Closed." },
  { key: "chatReply",   label: "Reply on HostelNode chat",   help: "Reply to enquiries inside HostelNode Messages." },
  { key: "convertLead", label: "Convert enquiry to tenant",  help: "One-click 'Convert to tenant' from Leads." },
];

const DURATION_UNITS = [
  { key: "day",   label: "Days" },
  { key: "month", label: "Months" },
  { key: "year",  label: "Years" },
];

// normal  = a plan owners can buy
// trial   = given free to every owner at the start; its duration is the trial length
// default = the free plan an owner falls back to after expiry; never expires
const ROLES = [
  { key: "normal",  label: "Normal plan (owners can buy it)" },
  { key: "trial",   label: "Trial plan (free, given automatically at the start)" },
  { key: "default", label: "Default plan (free, used after a plan expires)" },
];

module.exports = { LIMITS, FEATURES, DURATION_UNITS, ROLES };
