/* ============================================================
   utils/dashboardData.js  —  Phase 2: data for the global dashboard

   Read-only. Builds everything views/dashboard-v2.ejs shows, across
   ALL of the owner's properties (the Dashboard is global; Tenants,
   Payments, Rooms and Reports stay scoped to the selected property).

   Money uses the exact formulas of the existing Revenue page
   (GET /user/revenue), per member:
       fees = Σ payment.roomFees      paid = Σ payment.amountPaid
       due  = max(0, fees − paid)     advance = max(0, paid − fees)
   so these totals equal the sum of each property's Revenue page.
   Only members and rooms that belong to one of the owner's current
   properties are counted — the same set those pages show.
============================================================ */

const moment = require("moment-timezone");

const Room         = require("../models/room");
const Member       = require("../models/member");
const Listing      = require("../models/listingProperty");
const Enquiry      = require("../models/enquiry");
const Conversation = require("../models/Conversation");

const TZ = "Asia/Kolkata";

/* ── Formatting helpers (also used by the view) ── */

// ₹58,000 · ₹3.6L · ₹1.2Cr — Indian grouping, compact above 1 lakh.
function inr(n) {
  const v = Math.round(Number(n) || 0);
  const trim = x => x.toFixed(1).replace(/\.0$/, "");
  if (v >= 1e7) return "₹" + trim(v / 1e7) + "Cr";
  if (v >= 1e5) return "₹" + trim(v / 1e5) + "L";
  return "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v);
}

function timeAgo(date, now) {
  if (!date) return "";
  const m = moment(date).tz(TZ);
  const n = moment(now).tz(TZ);
  const mins = n.diff(m, "minutes");
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = n.diff(m, "hours");
  if (hrs < 24 && m.isSame(n, "day")) return hrs + "h ago";
  if (m.isSame(n.clone().subtract(1, "day"), "day")) return "yesterday";
  const days = n.clone().startOf("day").diff(m.clone().startOf("day"), "days");
  if (days < 7) return days + " days ago";
  return m.format("D MMM");
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0].toUpperCase()).join("") || "?";
}

// "A, B" / "A, B +2 more"
function nameList(names, max = 2) {
  const list = names.slice(0, max).join(", ");
  return names.length > max ? `${list} +${names.length - max} more` : list;
}

const ACTION_TEXT = {
  request_callback:  "asked for a callback",
  whatsapp_callback: "asked for a WhatsApp callback",
  schedule_visit:    "requested a visit",
  virtual_tour:      "asked for a virtual tour",
};

/* ── Main builder ── */

async function buildDashboard(ownerId, hostels, now = new Date()) {
  const hostelIds  = hostels.map(h => h._id);
  const hostelName = new Map(hostels.map(h => [String(h._id), h.hostelName]));

  const monthStart = moment(now).tz(TZ).startOf("month").toDate();
  const monthEnd   = moment(now).tz(TZ).endOf("month").toDate();

  const [rooms, members, listings] = await Promise.all([
    Room.find({ user: ownerId, hostel: { $in: hostelIds } }).lean(),
    Member.find({ user: ownerId, hostel: { $in: hostelIds } }).populate("payments").lean(),
    Listing.find({ owner: ownerId }, { _id: 1, title: 1 }).lean(),
  ]);

  /* Snapshot: beds and rooms */
  let totalBeds = 0, occupiedBeds = 0, bookedRooms = 0;
  const vacantByHostel = new Map();                 // hostelId → { beds, rooms: [] }
  for (const r of rooms) {
    const cap = Number(r.sharing_capacity) || 0;
    const occ = Number(r.occupied_beds) || 0;
    totalBeds    += cap;
    occupiedBeds += occ;
    if (occ > 0) bookedRooms++;
    const free = Math.max(0, cap - occ);
    if (free > 0) {
      const key = String(r.hostel);
      const v = vacantByHostel.get(key) || { beds: 0, rooms: [] };
      v.beds += free;
      v.rooms.push(r.room_number);
      vacantByHostel.set(key, v);
    }
  }

  /* Snapshot + attention: money (Revenue-page formulas) */
  let expected = 0, collected = 0, pending = 0, collectedThisMonth = 0;
  const dueByHostel = new Map();                    // hostelId → { amount, members }
  for (const m of members) {
    const pays = Array.isArray(m.payments) ? m.payments.filter(Boolean) : [];
    const fees = pays.reduce((s, p) => s + (Number(p.roomFees) || 0), 0);
    const paid = pays.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0);
    const due  = Math.max(0, fees - paid);
    expected  += fees;
    collected += paid;
    pending   += due;
    for (const p of pays) {
      const d = p.paymentDate ? new Date(p.paymentDate) : null;
      if (d && d >= monthStart && d <= monthEnd) collectedThisMonth += Number(p.amountPaid) || 0;
    }
    if (due > 0) {
      const key = String(m.hostel);
      const v = dueByHostel.get(key) || { amount: 0, members: 0 };
      v.amount  += due;
      v.members += 1;
      dueByHostel.set(key, v);
    }
  }

  /* Enquiries (Marketplace — every listing the owner has) */
  const listingIds   = listings.map(l => l._id);
  const listingTitle = new Map(listings.map(l => [String(l._id), l.title]));
  let recentEnquiries = [], newEnquiries = [], newEnquiryCount = 0;
  if (listingIds.length) {
    [recentEnquiries, newEnquiries, newEnquiryCount] = await Promise.all([
      Enquiry.find({ listing: { $in: listingIds } })
        .sort({ createdAt: -1 }).limit(4)
        .populate("student", "firstName lastName").lean(),
      Enquiry.find({ listing: { $in: listingIds }, status: "New" })
        .sort({ createdAt: -1 }).limit(1)
        .populate("student", "firstName lastName").lean(),
      Enquiry.countDocuments({ listing: { $in: listingIds }, status: "New" }),
    ]);
  }
  const personName = e => e && e.student
    ? [e.student.firstName, e.student.lastName].filter(Boolean).join(" ") || "HostelNode user"
    : "HostelNode user";

  /* Unread messages (same source as the Messages inbox) */
  const ownerKey = String(ownerId);
  const convs = await Conversation.find(
    { type: "PG_INQUIRY", ownerParticipant: ownerId },
    { [`unreadCounts.${ownerKey}`]: 1 }
  ).lean();
  const unreadMessages = convs.reduce((s, c) => s + (Number(c.unreadCounts?.[ownerKey]) || 0), 0);

  /* ── Needs attention: only rows that actually need action ── */
  const attention = [];

  if (dueByHostel.size) {
    const byAmount = [...dueByHostel.entries()].sort((a, b) => b[1].amount - a[1].amount);
    const count = byAmount.reduce((s, [, v]) => s + v.members, 0);
    const top = byAmount[0][0];
    attention.push({
      kind: "overdue",
      // Ledger-based (fees − paid > 0), the same rule as the Dues page —
      // there is no due date in the data, so this says "pending dues".
      title: `${count} tenant${count === 1 ? "" : "s"} with pending dues`,
      detail: `${inr(pending)} outstanding · ${nameList(byAmount.map(([id]) => hostelName.get(id) || "Property"))}`,
      action: "Collect",
      // Switch to the property with the most due, then open Collect Payment.
      href: `/user/hostel/${top}?next=/user/allfeesrecords`,
      hint: `Opens Collect Payment for ${hostelName.get(top) || "that property"}`,
    });
  }

  if (vacantByHostel.size) {
    const byBeds = [...vacantByHostel.entries()].sort((a, b) => b[1].beds - a[1].beds);
    const beds = byBeds.reduce((s, [, v]) => s + v.beds, 0);
    const [topId, topV] = byBeds[0];
    const roomsText = nameList(topV.rooms.map(n => `Room ${n}`), 3);
    const others = byBeds.length > 1 ? ` · +${byBeds.length - 1} more propert${byBeds.length - 1 === 1 ? "y" : "ies"}` : "";
    attention.push({
      kind: "vacant",
      title: `${beds} bed${beds === 1 ? "" : "s"} vacant`,
      detail: `${hostelName.get(topId) || "Property"} · ${roomsText}${others}`,
      action: "View",
      href: `/user/hostel/${topId}?next=/user/allrooms`,
      hint: `Opens All Rooms for ${hostelName.get(topId) || "that property"}`,
    });
  }

  if (newEnquiryCount > 0 && newEnquiries[0]) {
    const e = newEnquiries[0];
    const more = newEnquiryCount > 1 ? `, and ${newEnquiryCount - 1} more` : "";
    attention.push({
      kind: "enquiries",
      title: `${newEnquiryCount} new enquir${newEnquiryCount === 1 ? "y" : "ies"} unanswered`,
      detail: `${personName(e)} (${listingTitle.get(String(e.listing)) || "your listing"}) · ${timeAgo(e.createdAt, now)}${more}`,
      action: "Reply",
      href: "/user/my-listings",
      hint: "Opens your listings and their enquiries",
    });
  }

  if (unreadMessages > 0) {
    attention.push({
      kind: "messages",
      title: `${unreadMessages} unread message${unreadMessages === 1 ? "" : "s"}`,
      detail: "From people enquiring about your listings",
      action: "Open",
      href: "/user/messages",
      hint: "Opens Messages",
    });
  }

  /* ── Recent activity ── */
  const STATUS_CLASS = { New: "is-new", Contacted: "is-contacted", Closed: "is-closed" };
  const recent = recentEnquiries.map(e => {
    const name = personName(e);
    const what = ACTION_TEXT[e.actionType] || "sent an enquiry";
    return {
      name,
      initials: initials(name),
      detail: [listingTitle.get(String(e.listing)) || "Your listing", what, timeAgo(e.createdAt, now)].join(" · "),
      status: e.status || "New",
      statusClass: STATUS_CLASS[e.status] || "is-new",
    };
  });

  const collectionPct = expected > 0 ? Math.round((collected / expected) * 100) : 0;

  const hour = moment(now).tz(TZ).hour();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return {
    greeting,
    propertyCount: hostels.length,
    snapshot: {
      occupiedBeds, totalBeds,
      bookedRooms, totalRooms: rooms.length,
      tenants: members.length,               // same count as the All Tenants pages
      collectedThisMonth: inr(collectedThisMonth),
      pending: inr(pending),
    },
    attention,
    recent,
    hasListings: listingIds.length > 0,
    fee: {
      pct: Math.min(100, collectionPct),
      pctLabel: collectionPct + "%",
      expected: inr(expected),
    },
    // raw numbers, for tests and future use
    raw: { expected, collected, pending, collectedThisMonth, unreadMessages, newEnquiryCount },
  };
}

module.exports = { buildDashboard, inr, timeAgo };
