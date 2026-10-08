/* ============================================================
   utils/tenantOps.js  —  Property Operations Phase 1 (safety fixes)

   Small shared helpers for tenants, rooms and floors:

   • Who counts as "living here": a tenant with no move-out date who
     has not been removed. Moved-out and removed tenants never take
     a bed and are never charged rent.
   • Bed counts are RE-COUNTED from the real tenants after every
     change (syncRoom / syncFloor), instead of being added to and
     taken away from. A count can therefore never drift or go
     negative, and running it twice changes nothing.
   • Money per tenant (charges, paid, due, advance).
   • Safe search text and India-time due dates.
============================================================ */

const mongoose = require("mongoose");
const moment = require("moment-timezone");

const TZ = "Asia/Kolkata";

// A tenant who lives here now: not moved out, not removed.
const LIVING = { leftDate: null, removedAt: null };
// A tenant who still shows in the owner's lists (living or moved out, but not removed).
const NOT_REMOVED = { removedAt: null };

const isId = v => typeof v === "string" ? mongoose.isValidObjectId(v) && /^[0-9a-f]{24}$/i.test(v) : v instanceof mongoose.Types.ObjectId;

// Text typed into a search box, made safe to use inside a pattern.
const escapeRegex = s => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Re-count one room's occupied beds from its living tenants. Returns the room (lean) or null. */
async function syncRoom(roomId) {
  if (!roomId || !isId(String(roomId))) return null;
  const Room = require("../models/room");
  const Member = require("../models/member");
  const living = await Member.countDocuments({ assignedRoom_id: roomId, ...LIVING });
  return Room.findOneAndUpdate({ _id: roomId }, { $set: { occupied_beds: living } }, { new: true }).lean();
}

/** Re-count one floor's totals from its rooms. */
async function syncFloor(floorId) {
  if (!floorId || !isId(String(floorId))) return;
  const Room = require("../models/room");
  const Floor = require("../models/floor");
  const rooms = await Room.find({ floor_id: floorId }, { sharing_capacity: 1, occupied_beds: 1 }).lean();
  let totalBeds = 0, occupiedBeds = 0, fullRooms = 0;
  for (const r of rooms) {
    const cap = Math.max(0, Number(r.sharing_capacity) || 0);
    const occ = Math.max(0, Number(r.occupied_beds) || 0);
    totalBeds += cap;
    occupiedBeds += occ;
    if (cap > 0 && occ >= cap) fullRooms++;
  }
  await Floor.updateOne({ _id: floorId }, { $set: {
    total_rooms: rooms.length, total_beds: totalBeds, occupied_beds: occupiedBeds,
    occupied_rooms: fullRooms, active_number: occupiedBeds,
  } });
}

/** Re-count a room and the floor it is on. Never throws (counts are fixed on the next change or by the recount script). */
async function syncRoomAndFloor(roomId) {
  try {
    const room = await syncRoom(roomId);
    if (room && room.floor_id) await syncFloor(room.floor_id);
    return room;
  } catch (err) {
    console.error("Bed count sync (non-fatal):", err.message);
    return null;
  }
}

/** Charges, paid, due and advance for one tenant (payments populated). */
function money(member) {
  const pays = Array.isArray(member && member.payments) ? member.payments.filter(p => p && typeof p === "object") : [];
  const fees = pays.reduce((s, p) => s + (Number(p.roomFees) || 0), 0);
  const paid = pays.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0);
  return { fees, paid, due: Math.max(0, fees - paid), advance: Math.max(0, paid - fees) };
}

/**
 * The tenant's rent day in a given month (India time): the day of the month they joined,
 * moved to the last day for short months (joined on the 31st → 30 Sep, 28/29 Feb).
 */
function dueDateIn(joiningDate, monthMoment) {
  const j = moment(joiningDate).tz(TZ);
  const m = moment(monthMoment).tz(TZ).startOf("month");
  return m.clone().date(Math.min(j.date(), m.daysInMonth())).startOf("day");
}

/** Next rent day on or after `now` (India time). */
function nextDueDate(joiningDate, now = new Date()) {
  if (!joiningDate || isNaN(new Date(joiningDate))) return null;
  const today = moment(now).tz(TZ).startOf("day");
  let d = dueDateIn(joiningDate, today);
  if (d.isBefore(today)) d = dueDateIn(joiningDate, today.clone().add(1, "month"));
  return d;
}

// A date for display, never crashing on a missing or bad value.
const showDate = d => (d && !isNaN(new Date(d)) ? new Date(d).toLocaleDateString("en-GB", { timeZone: TZ }) : "—");

module.exports = { TZ, LIVING, NOT_REMOVED, isId, escapeRegex, syncRoom, syncFloor, syncRoomAndFloor, money, dueDateIn, nextDueDate, showDate };
