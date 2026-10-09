/* ============================================================
   utils/beds.js  —  Property Operations Phase 2 (rooms and beds)

   Every room has one bed per place of sharing: A, B, C… Each bed is
   Free, Occupied (a living tenant has that bed), or Blocked (repair).
   A bed can have its own rent; otherwise it uses the room's rent.

   • ensureBeds() keeps a room's bed list in step with its capacity
     and gives every living tenant a bed. Existing tenants who have no
     bed yet are placed A, B, C… in order of joining. Nothing about a
     tenant changes except their bed letter. Safe to run any time.
   • buildBedMap() collects one property's floors, rooms and beds for
     the Rooms & beds page.
   • refreshListings() writes the number of free beds onto the owner's
     listings linked to that property, so hostelnode.com shows real
     free beds ("3 beds free", "Full").
============================================================ */

const mongoose = require("mongoose");
const { LIVING } = require("./tenantOps");

// A, B, … Z, AA, AB, …
function bedLabels(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = "", k = i;
    do { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0);
    out.push(s);
  }
  return out;
}

// Sort "G01", "101", "1A", "Block B 2" the way people expect (numbers by value).
const natural = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

const bedRent = (room, label) => {
  const bed = (room.beds || []).find(b => b.label === label);
  return bed && bed.rent !== null && bed.rent !== undefined && bed.rent !== "" ? Number(bed.rent) : Number(room.room_fees) || 0;
};

// What a tenant pays each month: their own fixed rent if they have one
// (set when they were moved to a bed with a different rent), else their bed's rent.
const tenantRent = (member, room) =>
  member && member.rent !== null && member.rent !== undefined && member.rent !== "" ? Number(member.rent) : bedRent(room || {}, member && member.bedLabel);

/**
 * Bring one room's beds in step with its capacity and its living tenants.
 * `members` (optional) = the living tenants of this room, if already loaded.
 * Returns [{ label, rent, ownRent, blocked, blockNote, note, member }].
 */
async function ensureBeds(room, members) {
  const Room = require("../models/room");
  const Member = require("../models/member");
  if (!room) return [];
  const cap = Math.max(0, Math.min(200, Number(room.sharing_capacity) || 0));
  const labels = bedLabels(cap);
  const old = new Map((room.beds || []).map(b => [b.label, b]));
  const beds = labels.map(l => {
    const b = old.get(l) || {};
    return { label: l, rent: b.rent === undefined ? null : b.rent, blocked: !!b.blocked, blockNote: b.blockNote || "", note: b.note || "" };
  });

  const living = members || await Member.find({ assignedRoom_id: room._id, ...LIVING }, { name: 1, bedLabel: 1, joiningDate: 1, mobileNo: 1, rent: 1 }).lean();
  const ordered = [...living].sort((a, b) => (new Date(a.joiningDate || 0) - new Date(b.joiningDate || 0)) || String(a._id).localeCompare(String(b._id)));
  const taken = new Map();
  const moves = [];
  // Keep everyone who already has a valid, unique bed.
  for (const m of ordered) if (m.bedLabel && labels.includes(m.bedLabel) && !taken.has(m.bedLabel)) taken.set(m.bedLabel, m);
  // Everyone else gets the first free bed (a free unblocked one first; a blocked one only if nothing else is left).
  for (const m of ordered) {
    if ([...taken.values()].includes(m)) continue;
    const pick = beds.find(b => !taken.has(b.label) && !b.blocked) || beds.find(b => !taken.has(b.label));
    if (!pick) continue;   // more tenants than beds: left without a letter until the owner fixes the room
    if (pick.blocked) { pick.blocked = false; pick.blockNote = ""; }
    taken.set(pick.label, m);
    // A tenant who had a bed before (for example the room got fewer beds) keeps paying what they paid.
    const set = { bedLabel: pick.label };
    if (m.bedLabel) {
      const was = tenantRent(m, room), now = bedRent({ ...room, beds }, pick.label);
      const keep = was === now ? null : was;
      if (keep !== (typeof m.rent === "number" ? m.rent : null)) { set.rent = keep; m.rent = keep; }
    }
    moves.push({ id: m._id, set });
    m.bedLabel = pick.label;
  }
  // A bed someone lives in is never shown as blocked.
  for (const b of beds) if (taken.has(b.label) && b.blocked) { b.blocked = false; b.blockNote = ""; }

  const changed = JSON.stringify(beds) !== JSON.stringify((room.beds || []).map(b => ({ label: b.label, rent: b.rent === undefined ? null : b.rent, blocked: !!b.blocked, blockNote: b.blockNote || "", note: b.note || "" })));
  if (changed) {
    await Room.updateOne({ _id: room._id }, { $set: { beds } });
    room.beds = beds;
  }
  for (const mv of moves) await Member.updateOne({ _id: mv.id }, { $set: mv.set });

  return beds.map(b => ({ ...b, ownRent: b.rent !== null && b.rent !== "" && b.rent !== undefined, rent: bedRent({ ...room, beds }, b.label), member: taken.get(b.label) || null }));
}

/** One property's floors → rooms → beds, for the Rooms & beds page. */
async function buildBedMap(ownerId, hostelId) {
  const Floor = require("../models/floor");
  const Room = require("../models/room");
  const Member = require("../models/member");
  const [floors, rooms, living] = await Promise.all([
    Floor.find({ user: ownerId, hostel: hostelId }).lean(),
    Room.find({ user: ownerId, hostel: hostelId }).lean(),
    Member.find({ user: ownerId, hostel: hostelId, ...LIVING }, { name: 1, bedLabel: 1, joiningDate: 1, mobileNo: 1, assignedRoom_id: 1, rent: 1 }).lean(),
  ]);
  const byRoom = new Map();
  for (const m of living) {
    const k = String(m.assignedRoom_id || "");
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k).push(m);
  }
  const roomViews = [];
  for (const r of rooms) {
    const beds = await ensureBeds(r, byRoom.get(String(r._id)) || []);
    const free = beds.filter(b => !b.member && !b.blocked).length;
    roomViews.push({
      id: String(r._id), number: r.room_number, floorId: String(r.floor_id || ""), rent: Number(r.room_fees) || 0,
      capacity: Number(r.sharing_capacity) || 0, roomType: r.roomType || "", amenities: r.amenities || [],
      free, occupied: beds.filter(b => b.member).length, blocked: beds.filter(b => b.blocked).length,
      over: Math.max(0, (byRoom.get(String(r._id)) || []).length - beds.length),
      beds: beds.map(b => ({ label: b.label, rent: b.rent, ownRent: b.ownRent, blocked: b.blocked, blockNote: b.blockNote, note: b.note,
        member: b.member ? { id: String(b.member._id), name: b.member.name, since: b.member.joiningDate || null, rent: typeof b.member.rent === "number" ? b.member.rent : null } : null })),
    });
  }
  roomViews.sort((a, b) => natural(a.number, b.number));
  const floorViews = floors
    .sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || natural(a.floor_name, b.floor_name))
    .map(f => {
      const rs = roomViews.filter(r => r.floorId === String(f._id));
      return { id: String(f._id), name: f.floor_name, rooms: rs, beds: rs.reduce((s, r) => s + r.capacity, 0), free: rs.reduce((s, r) => s + r.free, 0), occupied: rs.reduce((s, r) => s + r.occupied, 0) };
    });
  // Rooms whose floor no longer exists still show, under "Other rooms".
  const known = new Set(floors.map(f => String(f._id)));
  const orphans = roomViews.filter(r => !known.has(r.floorId));
  if (orphans.length) floorViews.push({ id: "", name: "Other rooms", rooms: orphans, beds: orphans.reduce((s, r) => s + r.capacity, 0), free: orphans.reduce((s, r) => s + r.free, 0), occupied: orphans.reduce((s, r) => s + r.occupied, 0) });
  const total = roomViews.reduce((s, r) => s + r.capacity, 0);
  const occupied = roomViews.reduce((s, r) => s + r.occupied, 0);
  const free = roomViews.reduce((s, r) => s + r.free, 0);
  const blocked = roomViews.reduce((s, r) => s + r.blocked, 0);
  return { floors: floorViews, rooms: roomViews, total, occupied, free, blocked, percent: total ? Math.round((occupied / total) * 100) : 0 };
}

// "Single" → 1, "Double" → 2, "Triple" → 3, "4 Sharing" → 4 …
function typeCapacity(type) {
  const t = String(type || "").toLowerCase();
  // "2 sharing", "3-seater", "4 beds", "2 person" — or just "2"
  const n = t.match(/\b(\d{1,2})\s*-?\s*(sharing|share|shared|seater|seat|seats|bed|beds|bedded|person|persons|people|occupancy)\b/) || t.match(/^\s*(\d{1,2})\s*$/);
  if (n) return Number(n[1]) || null;
  const words = [[/\b(double|twin|two)\b/, 2], [/\b(triple|three)\b/, 3], [/\b(four|quad)\b/, 4], [/\bfive\b/, 5], [/\bsix\b/, 6],
    [/\bseven\b/, 7], [/\beight\b/, 8], [/\b(single|one|solo|private)\b|1 ?bed/, 1]];
  for (const [re, n] of words) if (re.test(t)) return n;
  return null;
}

/** Rooms (of the linked property) that a listing room type covers. */
function roomsForType(listingRoom, rooms) {
  const picked = (listingRoom.roomIds || []).map(String);
  if (picked.length) return rooms.filter(r => picked.includes(String(r._id || r.id)));
  const cap = typeCapacity(listingRoom.type);
  return cap ? rooms.filter(r => Number(r.sharing_capacity ?? r.capacity) === cap) : [];
}

/**
 * Write free-bed numbers onto every listing linked to this property.
 * Never throws; a listing that cannot be updated keeps its last numbers.
 */
async function refreshListings(hostelId) {
  try {
    if (!hostelId) return;
    const Listing = require("../models/listingProperty");
    const Room = require("../models/room");
    const Member = require("../models/member");
    const listings = await Listing.find({ linkedHostel: hostelId }, { rooms: 1 }).lean();
    if (!listings.length) return;
    const rooms = await Room.find({ hostel: hostelId }, { sharing_capacity: 1, beds: 1, room_number: 1 }).lean();
    const living = await Member.find({ hostel: hostelId, ...LIVING, assignedRoom_id: { $in: rooms.map(r => r._id) } }, { assignedRoom_id: 1 }).lean();
    const count = new Map();
    for (const m of living) count.set(String(m.assignedRoom_id), (count.get(String(m.assignedRoom_id)) || 0) + 1);
    const freeIn = r => {
      const cap = Number(r.sharing_capacity) || 0;
      const blocked = (r.beds || []).filter(b => b.blocked).length;
      return Math.max(0, cap - (count.get(String(r._id)) || 0) - blocked);
    };
    for (const l of listings) {
      const set = { bedsUpdatedAt: new Date() };
      const counted = new Set();
      let total = 0, matchedAny = false, unmatched = false;
      (l.rooms || []).forEach((lr, i) => {
        const rs = roomsForType(lr, rooms);
        // A room type we cannot match to any room (e.g. "Deluxe") keeps showing
        // the listing's own "Available now" / "Waitlist" — never a false "Full".
        if (!rs.length) { set[`rooms.${i}.freeBeds`] = null; unmatched = true; return; }
        matchedAny = true;
        set[`rooms.${i}.freeBeds`] = rs.reduce((s, r) => s + freeIn(r), 0);
        for (const r of rs) if (!counted.has(String(r._id))) { counted.add(String(r._id)); total += freeIn(r); }
      });
      // The search card shows one number for the whole listing; it is shown only when every room type is counted.
      set.freeBeds = matchedAny && !unmatched ? total : null;
      await Listing.updateOne({ _id: l._id, linkedHostel: hostelId }, { $set: set });
    }
  } catch (err) {
    console.error("Listing free beds (non-fatal):", err.message);
  }
}

module.exports = { bedLabels, natural, bedRent, tenantRent, ensureBeds, buildBedMap, typeCapacity, roomsForType, refreshListings };
