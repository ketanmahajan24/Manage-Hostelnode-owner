/* ============================================================
   utils/leads.js  —  Phase 3: Leads & CRM helpers

   Enquiries are created on hostelnode.com and stored in the same
   database. This app only READS them, and changes one field:
   `status` (New / Contacted / Closed — the model's own enum).
   Every read or write here first checks that the enquiry's listing
   belongs to the logged-in owner.
============================================================ */

const mongoose = require("mongoose");
const moment   = require("moment-timezone");

const Enquiry      = require("../models/enquiry");
const Listing      = require("../models/listingProperty");
const Conversation = require("../models/Conversation");

const TZ = "Asia/Kolkata";
const STATUSES = ["New", "Contacted", "Closed"];   // = models/enquiry.js enum
const LEADS    = ["Hot", "Warm", "Cold"];          // = models/enquiry.js enum
const PAGE_SIZE = 25;
const QUERY_MS  = 8000;   // give up rather than hang if the database is slow

// What the enquirer asked for — shown as a highlighted tag under their name.
// `key` picks the tag colour and icon in views/leads/index.ejs.
const CONTACT_TYPE = {
  request_callback:  { key: "callback", label: "Callback request" },
  whatsapp_callback: { key: "whatsapp", label: "WhatsApp request" },
  schedule_visit:    { key: "visit",    label: "Visit request" },
  virtual_tour:      { key: "tour",     label: "Virtual tour" },
  default:           { key: "general",  label: "Enquiry" },
};
// Older enquiries only have contactMethod.
const METHOD_TO_TYPE = { call: "request_callback", whatsapp: "whatsapp_callback", visit: "schedule_visit" };

const isId = v => typeof v === "string" && mongoose.isValidObjectId(v);

function timeAgo(date, now = new Date()) {
  if (!date) return "";
  const m = moment(date).tz(TZ), n = moment(now).tz(TZ);
  const mins = n.diff(m, "minutes");
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  if (m.isSame(n, "day")) return n.diff(m, "hours") + "h ago";
  if (m.isSame(n.clone().subtract(1, "day"), "day")) return "yesterday";
  const days = n.clone().startOf("day").diff(m.clone().startOf("day"), "days");
  return days < 7 ? days + " days ago" : m.format("D MMM");
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0].toUpperCase()).join("") || "?";
}

// 10-digit Indian mobile from whatever the student record holds, or "".
function indianMobile(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}

/** The enquiry, only if it is on one of this owner's listings; else null. */
async function loadOwnedEnquiry(enquiryId, ownerId) {
  if (!isId(enquiryId) || !ownerId) return null;
  const e = await Enquiry.findById(enquiryId)
    .populate("listing", "owner title")
    .populate("student", "firstName lastName phone")
    .lean();
  if (!e || !e.listing || String(e.listing.owner) !== String(ownerId)) return null;
  return e;
}

/** Set status. Returns true if changed. Refuses other owners' enquiries. */
async function setEnquiryStatus(enquiryId, ownerId, status) {
  if (!STATUSES.includes(status)) return false;
  const e = await loadOwnedEnquiry(enquiryId, ownerId);
  if (!e) return false;
  if (e.status === status) return true;
  await Enquiry.updateOne({ _id: e._id }, { $set: { status } });
  return true;
}

/** After "Convert to tenant" saves a tenant: close the enquiry. Never throws. */
async function closeEnquiryAfterConvert(enquiryId, ownerId) {
  try {
    if (!enquiryId) return;
    await setEnquiryStatus(String(enquiryId), ownerId, "Closed");
  } catch (err) {
    console.error("closeEnquiryAfterConvert (non-fatal):", err.message);
  }
}

/** Data for the Leads & CRM page. `q` is req.query. */
async function buildLeadsPage(ownerId, q = {}, now = new Date()) {
  const listings = await Listing.find({ owner: ownerId }, { title: 1, status: 1 }).sort({ createdAt: -1 }).lean();
  const listingIds = listings.map(l => l._id);
  const titleOf = new Map(listings.map(l => [String(l._id), l.title]));

  // Filters — anything not recognised is ignored, never trusted.
  const f = {
    listing: isId(q.listing) && titleOf.has(String(q.listing)) ? String(q.listing) : "",
    lead:    LEADS.includes(q.lead) ? q.lead : "",
    status:  STATUSES.includes(q.status) ? q.status : "",
    view:    q.view === "visits" ? "visits" : "",
  };
  let page = Math.max(1, Math.min(1000, parseInt(q.page, 10) || 1));

  const match = { listing: f.listing ? new mongoose.Types.ObjectId(f.listing) : { $in: listingIds } };
  if (f.lead)   match.leadCategory = f.lead;
  if (f.status) match.status = f.status;
  if (f.view === "visits") {
    // Older enquiries may only have contactMethod "visit" and no actionType.
    match.$or = [{ actionType: "schedule_visit" }, { actionType: { $exists: false }, contactMethod: "visit" }];
  }

  let rows = [], total = 0;
  if (listingIds.length) {
    total = await Enquiry.countDocuments(match).maxTimeMS(QUERY_MS);
    // Past the last page (e.g. after closing the last row) → show the last page.
    page = Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
    rows = await Enquiry.find(match)
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
      .populate("student", "firstName lastName phone")
      .maxTimeMS(QUERY_MS)
      .lean();
  }

  // Existing chat threads for these rows, so Reply can open Messages.
  const convKey = (listing, student) => `${listing}:${student}`;
  const threads = new Map();
  if (rows.length) {
    const convs = await Conversation.find(
      { type: "PG_INQUIRY", ownerParticipant: ownerId, listing: { $in: [...new Set(rows.map(r => String(r.listing)))] } },
      { participants: 1, listing: 1 }
    ).lean();
    for (const c of convs) for (const p of c.participants || []) threads.set(convKey(c.listing, p), String(c._id));
  }

  const items = rows.map(e => {
    const s = e.student || null;
    const name = s ? [s.firstName, s.lastName].filter(Boolean).join(" ") || "HostelNode user" : "HostelNode user";
    const listingTitle = titleOf.get(String(e.listing)) || "Listing";
    const thread = s ? threads.get(convKey(e.listing, s._id)) : null;
    const mobile = s ? indianMobile(s.phone) : "";
    // Two ways to reply: the HostelNode chat (only if the enquirer has
    // started one — owners can't open a new chat) and WhatsApp (if the
    // enquirer's number is a valid Indian mobile).
    const replyChat = thread ? { href: `/user/messages/${thread}` } : null;
    const replyWhatsApp = mobile ? {
      href: `https://wa.me/91${mobile}?text=${encodeURIComponent(`Hi ${s.firstName || ""}, thanks for your enquiry about ${listingTitle} on HostelNode.`.replace("Hi ,", "Hi,"))}`,
    } : null;
    const visitDate = e.preferredDate ? moment(e.preferredDate).tz(TZ).format("D MMM") : "";
    return {
      id: String(e._id),
      name,
      initials: initials(name),
      contactType: CONTACT_TYPE[e.actionType] || CONTACT_TYPE[METHOD_TO_TYPE[e.contactMethod]] || CONTACT_TYPE.default,
      when: timeAgo(e.createdAt, now),
      listingTitle,
      moveIn: f.view === "visits" ? (visitDate || "—") : (e.moveIn || visitDate || "—"),
      budget: e.budgetRange || "—",
      lead: LEADS.includes(e.leadCategory) ? e.leadCategory : "",
      status: STATUSES.includes(e.status) ? e.status : "New",
      replyChat,
      replyWhatsApp,
      canConvert: e.status !== "Closed",
      roomType: e.roomType || "",
    };
  });

  return {
    filters: f,
    listings: listings.map(l => ({ id: String(l._id), title: l.title })),
    liveCount: listings.filter(l => !l.status || l.status === "Approved").length,
    listingTitle: f.listing ? titleOf.get(f.listing) : "",
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    statuses: STATUSES,
  };
}

module.exports = {
  STATUSES, LEADS,
  loadOwnedEnquiry, setEnquiryStatus, closeEnquiryAfterConvert, buildLeadsPage, indianMobile,
};
