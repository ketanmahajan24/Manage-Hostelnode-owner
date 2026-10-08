/* ============================================================
   scripts/recount-beds.js  —  Property Operations Phase 1, run once

   Puts every room's and floor's bed numbers right, counted from the
   tenants who really live there, and marks tenants who live here but
   were shown as "Inactive" only because they had not paid yet.

   Usage (from the project folder, uses MONGO_URL from .env):
     node scripts/recount-beds.js           shows what it WOULD change, changes nothing
     node scripts/recount-beds.js --apply   makes the changes

   Safe to run again at any time: it only ever sets counts to the true
   numbers. It deletes nothing.
============================================================ */

require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const APPLY = process.argv.includes("--apply");
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is not set.");
  await mongoose.connect(process.env.MONGO_URL);
  const Member = require("../models/member");
  const Room = require("../models/room");
  const Floor = require("../models/floor");
  const { LIVING, syncRoom, syncFloor } = require("../utils/tenantOps");

  console.log(APPLY ? "Applying changes.\n" : "Dry run: nothing will be changed. Add --apply to make these changes.\n");

  // 1. Living tenants shown as "Inactive" (added but never paid, under the old rules).
  const unpaid = await Member.find({ ...LIVING, status: { $ne: "Active" } }, { name: 1, assignedRoom: 1, joiningDate: 1 }).lean();
  console.log(`Tenants who live here but are marked Inactive: ${unpaid.length}`);
  unpaid.slice(0, 50).forEach(m => console.log(`  - ${m.name} (room ${m.assignedRoom || "?"})`));
  if (unpaid.length > 50) console.log(`  … and ${unpaid.length - 50} more`);
  if (APPLY && unpaid.length) {
    const r = await Member.updateMany({ _id: { $in: unpaid.map(m => m._id) }, ...LIVING }, { $set: { status: "Active" } });
    console.log(`  → ${r.modifiedCount} marked Active`);
  }

  // 2. Room bed counts.
  const rooms = await Room.find({}, { occupied_beds: 1, room_number: 1, sharing_capacity: 1 }).lean();
  let roomFixes = 0, overfull = 0;
  for (const r of rooms) {
    const living = await Member.countDocuments({ assignedRoom_id: r._id, ...LIVING });
    if (living !== (Number(r.occupied_beds) || 0)) {
      roomFixes++;
      if (roomFixes <= 50) console.log(`  room ${r.room_number}: shows ${r.occupied_beds || 0} occupied, really ${living}`);
      if (APPLY) await syncRoom(r._id);
    }
    if (living > (Number(r.sharing_capacity) || 0)) overfull++;
  }
  console.log(`Rooms with a wrong count: ${roomFixes} of ${rooms.length}`);
  if (overfull) {
    console.log(`Rooms with more tenants than beds: ${overfull}. Some of these tenants may have moved out earlier`);
    console.log(`(old versions cleared the move-out date when a payment was recorded). Please check them and move out anyone who has left:`);
    for (const r of rooms) {
      const people = await Member.find({ assignedRoom_id: r._id, ...LIVING }, { name: 1 }).lean();
      if (people.length > (Number(r.sharing_capacity) || 0)) console.log(`  room ${r.room_number} (${r.sharing_capacity} beds): ${people.map(p => p.name).join(", ")}`);
    }
  }

  // 3. Floor totals.
  const floors = await Floor.find({}, { _id: 1 }).lean();
  if (APPLY) for (const f of floors) await syncFloor(f._id);
  console.log(`Floors ${APPLY ? "recounted" : "to recount"}: ${floors.length}`);

  await mongoose.disconnect();
  console.log(APPLY ? "\nDone." : "\nNothing was changed.");
})().catch(err => { console.error("Recount failed:", err.message); process.exit(1); });
