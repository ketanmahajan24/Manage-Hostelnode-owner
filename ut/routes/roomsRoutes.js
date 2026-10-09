/* ============================================================
   routes/roomsRoutes.js  —  Property Operations Phase 2: rooms, floors and beds

   GET  /user/allrooms                       Rooms & beds (bed map)
   GET  /user/managerooms, /user/managefloor  → the new pages (old links keep working)
   GET  /user/newroom                        Add rooms (one, or many at once)
   POST /user/newroom                        add one room
   POST /user/rooms/bulk                     add many rooms (e.g. 201 to 208)
   GET  /user/managerooms/:id/edit           edit a room
   PUT  /user/manageroom/:id                 save a room
   DELETE /user/managerooms/:id              delete an empty room
   POST /user/rooms/:id/beds/:label/block    block / unblock a free bed
   POST /user/rooms/:id/beds/:label/rent     a bed's own rent (empty = room rent)
   POST /user/rooms/:id/beds/add             one more bed in the room
   POST /user/members/:id/move               move a tenant to another free bed
   GET  /user/floors                         Floors
   GET  /user/newfloor                       → Floors (add form is on that page)
   POST /user/floors/:id/rename, /move       rename, move up/down
   GET/POST /user/listing/:id/link           link a listing to a property (free beds on hostelnode.com)

   Mounted before routes/userRoutes.js, so these replace the old pages with the
   same addresses. Everything is limited to the logged-in owner and, where it
   matters, to the property selected in the switcher.
============================================================ */

const express = require("express");
const router = express.Router();
const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const Floor = require("../models/floor");
const Room = require("../models/room");
const Member = require("../models/member");
const Listing = require("../models/listingProperty");
const Hostel = require("../models/hostel");
const { LIVING, isId, escapeRegex, syncRoomAndFloor, syncFloor } = require("../utils/tenantOps");
const { bedLabels, natural, bedRent, tenantRent, ensureBeds, buildBedMap, typeCapacity, roomsForType, refreshListings } = require("../utils/beds");

const AMENITIES = ["Attached bathroom", "Balcony", "Study table", "Wardrobe", "Window"];
const MAX_BEDS = 20;

const clean = (s, max = 100) => (typeof s === "string" ? s.trim().replace(/<[^>]*>/g, "").slice(0, max) : "");
function moneyIn(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}
const roomTypeIn = v => (v === "AC" || v === "Non-AC" ? v : "");
const amenitiesIn = v => [].concat(v || []).filter(a => AMENITIES.includes(a));
const back = (res, url, msg) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const fail = (res, url, msg) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}err=${encodeURIComponent(msg)}`);
const flash = req => ({ msg: clean(req.query.msg || "", 200), err: clean(req.query.err || "", 200) });

// Pages that need a property selected.
function needHostel(req, res, next) {
  if (res.locals.selectedHostel && res.locals.selectedHostel._id) return next();
  return res.redirect("/user");   // the dashboard / first-property screen
}
const H = res => res.locals.selectedHostel._id;

// A room of this owner in the selected property.
const myRoom = (req, res, id) => (isId(String(id || "")) ? Room.findOne({ _id: id, user: req.user.id, hostel: H(res) }) : null);

/* ── Rooms & beds ─────────────────────────────────────────── */
router.get("/allrooms", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const [user, map] = await Promise.all([Owner.findById(req.user.id), buildBedMap(req.user.id, H(res))]);
    res.render("rooms/bedMap.ejs", { user, map, hostelName: res.locals.selectedHostel.hostelName || "", flash: flash(req) });
  } catch (err) {
    console.error("Rooms & beds error:", err.message);
    res.status(500).send("Something went wrong loading your rooms. Please try again.");
  }
});
router.get("/managerooms", jwtAuthMiddleware, (req, res) => res.redirect("/user/allrooms"));
router.get("/managefloor", jwtAuthMiddleware, (req, res) => res.redirect("/user/floors"));
router.get("/newfloor", jwtAuthMiddleware, (req, res) => res.redirect("/user/floors#add"));

/* ── Add rooms ────────────────────────────────────────────── */
router.get("/newroom", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const [user, floors, rooms] = await Promise.all([
      Owner.findById(req.user.id),
      Floor.find({ user: req.user.id, hostel: H(res) }).lean(),
      Room.find({ user: req.user.id, hostel: H(res) }, { room_number: 1, floor_id: 1 }).lean(),
    ]);
    floors.sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || natural(a.floor_name, b.floor_name));
    const existing = {};
    for (const r of rooms) (existing[String(r.floor_id)] = existing[String(r.floor_id)] || []).push(String(r.room_number).toLowerCase());
    res.render("rooms/addRooms.ejs", {
      user, floors: floors.map(f => ({ id: String(f._id), name: f.floor_name })), existing, amenities: AMENITIES,
      pick: isId(String(req.query.floor || "")) ? String(req.query.floor) : "", mode: req.query.mode === "one" ? "one" : "many", flash: flash(req),
    });
  } catch (err) {
    console.error("Add rooms page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

async function createRooms(req, res, floorId, numbers, { capacity, rent, roomType, amenities }) {
  const floor = isId(String(floorId || "")) ? await Floor.findOne({ _id: floorId, user: req.user.id, hostel: H(res) }) : null;
  if (!floor) return { error: "Choose a floor first." };
  const existing = new Set((await Room.find({ floor_id: floor._id, hostel: H(res) }, { room_number: 1 }).lean()).map(r => String(r.room_number).toLowerCase()));
  const toAdd = numbers.filter(n => !existing.has(n.toLowerCase()));
  const skipped = numbers.length - toAdd.length;
  const beds = bedLabels(capacity).map(label => ({ label, rent: null, blocked: false, blockNote: "", note: "" }));
  for (const n of toAdd) {
    await Room.create({ user: req.user.id, hostel: H(res), floor_id: floor._id, floor_name: floor.floor_name, room_number: n,
      room_fees: rent, sharing_capacity: capacity, occupied_beds: 0, roomType, amenities, beds });
  }
  await syncFloor(floor._id).catch(() => {});
  await refreshListings(H(res));
  return { added: toAdd.length, skipped };
}

function roomFields(body) {
  const capacity = Number(body.sharing_capacity);
  const rent = moneyIn(body.room_fees);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_BEDS) return { error: `Beds per room must be a whole number from 1 to ${MAX_BEDS}.` };
  if (rent === null) return { error: "Enter the rent per bed as a number." };
  return { capacity, rent, roomType: roomTypeIn(body.roomType), amenities: amenitiesIn(body.amenities) };
}

router.post("/newroom", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const b = req.body.room || {};
    const number = clean(b.room_number || "", 20);
    if (!number) return fail(res, "/user/newroom?mode=one", "Enter a room number.");
    const f = roomFields(b);
    if (f.error) return fail(res, "/user/newroom?mode=one", f.error);
    const r = await createRooms(req, res, b.floor_id, [number], f);
    if (r.error) return fail(res, "/user/newroom?mode=one", r.error);
    if (!r.added) return fail(res, "/user/newroom?mode=one", `Room ${number} already exists on that floor.`);
    back(res, "/user/allrooms", `Room ${number} added.`);
  } catch (err) {
    console.error("Add room error:", err.message);
    fail(res, "/user/newroom?mode=one", "The room could not be added. Please try again.");
  }
});

// "201" to "208", "G01" to "G08", "A-1" to "A-9": same letters before the number, number counts up, zeros kept.
function roomRange(from, to) {
  const a = String(from || "").trim().match(/^(.*?)(\d+)$/), b = String(to || "").trim().match(/^(.*?)(\d+)$/);
  if (!a || !b) return { error: "Room numbers must end in a number, for example 201 to 208 or G01 to G08." };
  if (a[1].toLowerCase() !== b[1].toLowerCase()) return { error: "Both room numbers must start the same way (for example G01 and G08)." };
  const start = Number(a[2]), end = Number(b[2]);
  if (end < start) return { error: "The last room number must be after the first." };
  if (end - start + 1 > 60) return { error: "Add at most 60 rooms at a time." };
  const width = a[2].length;
  const list = [];
  for (let n = start; n <= end; n++) list.push(a[1] + String(n).padStart(width, "0"));
  if (list.some(n => n.length > 20)) return { error: "Room numbers are too long." };
  return { list };
}

router.post("/rooms/bulk", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const b = req.body.room || {};
    const range = roomRange(clean(b.from, 20), clean(b.to, 20));
    if (range.error) return fail(res, "/user/newroom", range.error);
    const f = roomFields(b);
    if (f.error) return fail(res, "/user/newroom", f.error);
    const r = await createRooms(req, res, b.floor_id, range.list, f);
    if (r.error) return fail(res, "/user/newroom", r.error);
    back(res, "/user/allrooms", `${r.added} room${r.added === 1 ? "" : "s"} added${r.skipped ? `, ${r.skipped} skipped (already there)` : ""}.`);
  } catch (err) {
    console.error("Bulk add rooms error:", err.message);
    fail(res, "/user/newroom", "The rooms could not be added. Please try again.");
  }
});

/* ── Edit / delete a room ─────────────────────────────────── */
router.get("/managerooms/:id/edit", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const room = await myRoom(req, res, req.params.id);
    if (!room) return res.status(404).send("Room not found or you are not authorized.");
    const [user, floors, living] = await Promise.all([
      Owner.findById(req.user.id),
      Floor.find({ user: req.user.id, hostel: H(res) }).lean(),
      Member.countDocuments({ assignedRoom_id: room._id, ...LIVING }),
    ]);
    floors.sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || natural(a.floor_name, b.floor_name));
    res.render("rooms/editRoom.ejs", { user, room, living, floors: floors.map(f => ({ id: String(f._id), name: f.floor_name })), amenities: AMENITIES, flash: flash(req) });
  } catch (err) {
    console.error("Edit room page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.put("/manageroom/:id", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  const url = `/user/managerooms/${encodeURIComponent(req.params.id)}/edit`;
  try {
    const room = await myRoom(req, res, req.params.id);
    if (!room) return res.status(404).send("Room not found.");
    const b = req.body.room || {};
    const f = roomFields({ ...b, room_fees: b.room_fees, sharing_capacity: b.sharing_capacity });
    if (f.error) return fail(res, url, f.error);
    const living = await Member.countDocuments({ assignedRoom_id: room._id, ...LIVING });
    if (f.capacity < living) return fail(res, url, `${living} tenant${living === 1 ? " lives" : "s live"} in this room, so it needs at least ${living} bed${living === 1 ? "" : "s"}.`);
    // Fewer beds: tenants in the removed beds need a free bed that is not blocked.
    if (f.capacity < (Number(room.sharing_capacity) || 0)) {
      const keep = new Set(bedLabels(f.capacity));
      const people = await Member.find({ assignedRoom_id: room._id, ...LIVING }, { bedLabel: 1 }).lean();
      const homeless = people.filter(m => !m.bedLabel || !keep.has(m.bedLabel)).length;
      const used = new Set(people.map(m => m.bedLabel).filter(l => keep.has(l)));
      const open = (room.beds || []).filter(b => keep.has(b.label) && !used.has(b.label) && !b.blocked).length + [...keep].filter(l => !(room.beds || []).some(b => b.label === l) && !used.has(l)).length;
      if (homeless > open) return fail(res, url, "A tenant in a bed you are removing would have to go into a blocked bed. Unblock that bed or move the tenant first.");
    }

    const set = { room_fees: f.rent, sharing_capacity: f.capacity, roomType: f.roomType, amenities: f.amenities };
    const number = clean(b.room_number || "", 20) || room.room_number;
    let floorId = room.floor_id;
    if (b.floor_id && String(b.floor_id) !== String(room.floor_id)) {
      const floor = isId(String(b.floor_id)) ? await Floor.findOne({ _id: b.floor_id, user: req.user.id, hostel: H(res) }) : null;
      if (!floor) return fail(res, url, "Choose one of your floors.");
      floorId = floor._id; set.floor_id = floor._id; set.floor_name = floor.floor_name;
    }
    if (number.toLowerCase() !== String(room.room_number).toLowerCase() || String(floorId) !== String(room.floor_id)) {
      const clash = await Room.findOne({ _id: { $ne: room._id }, floor_id: floorId, hostel: H(res), room_number: { $regex: `^${escapeRegex(number)}$`, $options: "i" } });
      if (clash) return fail(res, url, `Room ${number} already exists on that floor.`);
    }
    set.room_number = number;
    await Room.updateOne({ _id: room._id, user: req.user.id }, { $set: set });
    if (number !== room.room_number) await Member.updateMany({ assignedRoom_id: room._id }, { $set: { assignedRoom: number } });
    await ensureBeds(await Room.findById(room._id).lean());
    await syncRoomAndFloor(room._id);
    if (String(floorId) !== String(room.floor_id)) await syncFloor(room.floor_id).catch(() => {});
    back(res, "/user/allrooms", `Room ${number} saved.`);
  } catch (err) {
    console.error("Save room error:", err.message);
    fail(res, url, "The room could not be saved. Please try again.");
  }
});

router.delete("/managerooms/:id", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const room = await myRoom(req, res, req.params.id);
    if (!room) return res.status(404).send("Room not found.");
    const living = await Member.countDocuments({ assignedRoom_id: room._id, ...LIVING });
    if (living) return fail(res, "/user/allrooms", `${living} tenant${living === 1 ? " lives" : "s live"} in room ${room.room_number}. Move ${living === 1 ? "them" : "them"} out or to another room first.`);
    await Room.deleteOne({ _id: room._id, user: req.user.id });
    await syncFloor(room.floor_id).catch(() => {});
    await refreshListings(H(res));
    back(res, "/user/allrooms", `Room ${room.room_number} deleted.`);
  } catch (err) {
    console.error("Delete room error:", err.message);
    res.status(500).send("Delete failed. Please try again.");
  }
});

/* ── Beds ─────────────────────────────────────────────────── */
async function loadBed(req, res) {
  const room = await myRoom(req, res, req.params.id);
  if (!room) return {};
  const beds = await ensureBeds(room.toObject());
  const at = beds.findIndex(b => b.label === String(req.params.label || "").toUpperCase());
  // Beds are saved by position ("beds.2.blocked"), checked against the letter, so the right bed always changes.
  return { room, beds, bed: at >= 0 ? beds[at] : null, at, where: at >= 0 ? { _id: room._id, [`beds.${at}.label`]: beds[at].label } : null };
}

router.post("/rooms/:id/beds/:label/block", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const { room, bed, at, where } = await loadBed(req, res);
    if (!room || !bed) return res.status(404).send("Bed not found.");
    const block = req.body.unblock !== "1";
    if (block && bed.member) return fail(res, "/user/allrooms", `${bed.member.name} lives in bed ${bed.label}. Only a free bed can be blocked.`);
    await Room.updateOne(where, { $set: { [`beds.${at}.blocked`]: block, [`beds.${at}.blockNote`]: block ? clean(req.body.note || "", 60) : "" } });
    await refreshListings(H(res));
    back(res, "/user/allrooms", `Bed ${room.room_number}-${bed.label} ${block ? "blocked" : "is free again"}.`);
  } catch (err) {
    console.error("Block bed error:", err.message);
    fail(res, "/user/allrooms", "That change could not be saved. Please try again.");
  }
});

router.post("/rooms/:id/beds/:label/rent", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const { room, bed, at, where } = await loadBed(req, res);
    if (!room || !bed) return res.status(404).send("Bed not found.");
    const raw = String(req.body.rent || "").trim();
    const rent = raw === "" ? null : moneyIn(raw);
    if (raw !== "" && rent === null) return fail(res, "/user/allrooms", "Enter the bed's rent as a number, or leave it empty to use the room rent.");
    const note = clean(req.body.note || "", 40);
    await Room.updateOne(where, { $set: { [`beds.${at}.rent`]: rent === room.room_fees ? null : rent, [`beds.${at}.note`]: note } });
    back(res, "/user/allrooms", `Bed ${room.room_number}-${bed.label} saved. Its rent is ₹${(rent === null ? room.room_fees : rent).toLocaleString("en-IN")} a month.`);
  } catch (err) {
    console.error("Bed rent error:", err.message);
    fail(res, "/user/allrooms", "That change could not be saved. Please try again.");
  }
});

router.post("/rooms/:id/beds/add", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const room = await myRoom(req, res, req.params.id);
    if (!room) return res.status(404).send("Room not found.");
    if ((Number(room.sharing_capacity) || 0) >= MAX_BEDS) return fail(res, "/user/allrooms", `A room can have at most ${MAX_BEDS} beds.`);
    await Room.updateOne({ _id: room._id }, { $inc: { sharing_capacity: 1 } });
    await ensureBeds(await Room.findById(room._id).lean());
    await syncRoomAndFloor(room._id);
    back(res, "/user/allrooms", `A bed was added to room ${room.room_number}.`);
  } catch (err) {
    console.error("Add bed error:", err.message);
    fail(res, "/user/allrooms", "The bed could not be added. Please try again.");
  }
});

// Move a tenant who lives here to another free bed (same property).
async function moveTenant(req, res) {
  // Phase 3: the tenant page sends back=tenant, to return there.
  const done = isId(String(req.params.id)) && req.body.back === "tenant" ? `/user/tenants/${req.params.id}` : "/user/allrooms";
  try {
    if (!isId(req.params.id)) return res.status(404).send("Tenant not found.");
    const member = await Member.findOne({ _id: req.params.id, user: req.user.id, hostel: H(res), ...LIVING });
    if (!member) return res.status(404).send("Tenant not found.");
    const [roomId, label] = String(req.body.to || "").split(":");
    const target = await myRoom(req, res, roomId);
    if (!target) return fail(res, done, "Choose a free bed to move to.");
    const beds = await ensureBeds(target.toObject());
    const bed = beds.find(b => b.label === String(label || ""));
    if (!bed || bed.member || bed.blocked) return fail(res, done, "That bed is not free any more. Please choose another.");
    const from = member.assignedRoom_id;
    const before = { assignedRoom_id: member.assignedRoom_id, assignedRoom: member.assignedRoom, bedLabel: member.bedLabel, rent: member.rent === undefined ? null : member.rent };
    const set = { assignedRoom_id: target._id, assignedRoom: target.room_number, bedLabel: bed.label };
    // Their rent stays the same: if the new bed costs a different amount, fix what they pay now;
    // if it costs exactly what they pay, they simply pay the bed's rent again.
    const oldRoom = from ? await Room.findById(from, { room_fees: 1, beds: 1 }).lean() : null;
    const pays = oldRoom ? tenantRent(member, oldRoom) : (typeof member.rent === "number" ? member.rent : null);
    if (pays !== null) set.rent = pays === bed.rent ? null : pays;
    // Phase 3: "Charge the new bed's rent" ticked on the tenant page.
    const newRent = req.body.useNewRent === "1";
    if (newRent) set.rent = null;
    await Member.updateOne({ _id: member._id }, { $set: set });
    // Someone else took this bed at the same moment? Put this tenant back and say so.
    const sharing = await Member.countDocuments({ assignedRoom_id: target._id, bedLabel: bed.label, ...LIVING });
    if (sharing > 1) {
      await Member.updateOne({ _id: member._id }, { $set: before });
      return fail(res, done, "That bed was just taken. Please choose another.");
    }
    await syncRoomAndFloor(target._id);
    if (from && String(from) !== String(target._id)) await syncRoomAndFloor(from);
    const T = require("../utils/tenants");
    const nowPays = newRent ? bed.rent : (pays !== null ? pays : bed.rent);
    await T.logEvent(req, member, "moved", `Moved from ${member.assignedRoom || "—"} · ${member.bedLabel || "—"} to ${target.room_number} · ${bed.label}`,
      newRent && pays !== null && pays !== bed.rent ? `rent ${T.inr(pays)} → ${T.inr(bed.rent)} from the next rent` : `rent stays ${T.inr(nowPays)}`);
    back(res, done, `${member.name} moved to room ${target.room_number}, bed ${bed.label}. ${newRent && pays !== null && pays !== bed.rent ? `Rent is now ${T.inr(bed.rent)} from the next rent.` : "Their rent stays the same."}`);
  } catch (err) {
    console.error("Move tenant error:", err.message);
    fail(res, done, "The move could not be saved. Please try again.");
  }
}
router.post("/members/:id/move", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    for (let i = 0; i < 20; i++) {
      const r = await require("../utils/locks").withLocks([isId(String(req.body.to || "").split(":")[0]) ? `room:${String(req.body.to).split(":")[0]}` : ""], () => moveTenant(req, res));
      if (!r.busy) return;
      await new Promise(z => setTimeout(z, 250));
    }
    res.redirect((req.body.back === "tenant" && isId(String(req.params.id)) ? `/user/tenants/${req.params.id}` : "/user/allrooms") + "?err=" + encodeURIComponent("Someone else is changing that room right now. Please try again."));
  } catch (err) {
    console.error("moveTenant (lock) error:", err.message);
    if (!res.headersSent) res.status(500).send("That could not be saved. Please try again.");
  }
});

// A tenant who kept an older rent after a move starts paying their bed's rent (from the next month).
router.post("/members/:id/rent-reset", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).send("Tenant not found.");
    const member = await Member.findOne({ _id: req.params.id, user: req.user.id, hostel: H(res), ...LIVING });
    if (!member) return res.status(404).send("Tenant not found.");
    const room = member.assignedRoom_id ? await Room.findById(member.assignedRoom_id, { room_fees: 1, beds: 1 }).lean() : null;
    await Member.updateOne({ _id: member._id }, { $set: { rent: null } });
    if (room) { const T = require("../utils/tenants"); await T.logEvent(req, member, "rent", `Rent changed ${T.inr(member.rent)} → ${T.inr(bedRent(room, member.bedLabel))}`, "now pays the bed's rent, from the next rent"); }
    back(res, req.body.back === "tenant" ? `/user/tenants/${member._id}` : "/user/allrooms", `${member.name} now pays the bed's rent${room ? ` (₹${bedRent(room, member.bedLabel).toLocaleString("en-IN")} a month)` : ""}, from the next rent.`);
  } catch (err) {
    console.error("Rent reset error:", err.message);
    fail(res, "/user/allrooms", "That change could not be saved. Please try again.");
  }
});

/* ── Floors ───────────────────────────────────────────────── */
router.get("/floors", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const [user, map] = await Promise.all([Owner.findById(req.user.id), buildBedMap(req.user.id, H(res))]);
    res.render("rooms/floors.ejs", { user, map, hostelName: res.locals.selectedHostel.hostelName || "", flash: flash(req) });
  } catch (err) {
    console.error("Floors page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/newfloor", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const name = clean((req.body.floor || {}).floor_name || "", 40);
    if (!name) return fail(res, "/user/floors#add", "Enter a floor name.");
    const clash = await Floor.findOne({ user: req.user.id, hostel: H(res), floor_name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
    if (clash) return fail(res, "/user/floors#add", `A floor called "${name}" already exists.`);
    const last = await Floor.find({ user: req.user.id, hostel: H(res) }, { sortOrder: 1 }).lean();
    const order = last.reduce((m, f) => Math.max(m, Number(f.sortOrder) || 0), 0) + 10;
    await Floor.create({ floor_name: name, user: req.user.id, hostel: H(res), sortOrder: order });
    back(res, "/user/floors", `Floor ${name} added. Now add its rooms.`);
  } catch (err) {
    console.error("Add floor error:", err.message);
    fail(res, "/user/floors", "The floor could not be added. Please try again.");
  }
});

router.delete("/managefloor/:id", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).send("Floor not found.");
    const floor = await Floor.findOne({ _id: req.params.id, user: req.user.id, hostel: H(res) });
    if (!floor) return res.status(404).send("Floor not found.");
    const rooms = await Room.countDocuments({ floor_id: floor._id });
    if (rooms) return fail(res, "/user/floors", `${floor.floor_name} still has ${rooms} room${rooms === 1 ? "" : "s"}. Delete or move ${rooms === 1 ? "that room" : "those rooms"} first.`);
    await Floor.deleteOne({ _id: floor._id });
    back(res, "/user/floors", `Floor ${floor.floor_name} deleted.`);
  } catch (err) {
    console.error("Delete floor error:", err.message);
    res.status(500).send("Delete failed. Please try again.");
  }
});

router.post("/floors/:id/rename", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).send("Floor not found.");
    const name = clean(req.body.floor_name || "", 40);
    if (!name) return fail(res, "/user/floors", "Enter a floor name.");
    const floor = await Floor.findOne({ _id: req.params.id, user: req.user.id, hostel: H(res) });
    if (!floor) return res.status(404).send("Floor not found.");
    const clash = await Floor.findOne({ _id: { $ne: floor._id }, user: req.user.id, hostel: H(res), floor_name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
    if (clash) return fail(res, "/user/floors", `A floor called "${name}" already exists.`);
    await Floor.updateOne({ _id: floor._id }, { $set: { floor_name: name } });
    await Room.updateMany({ floor_id: floor._id }, { $set: { floor_name: name } });
    back(res, "/user/floors", `Floor renamed to ${name}.`);
  } catch (err) {
    console.error("Rename floor error:", err.message);
    fail(res, "/user/floors", "The floor could not be renamed. Please try again.");
  }
});

router.post("/floors/:id/move", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const floors = await Floor.find({ user: req.user.id, hostel: H(res) }).lean();
    floors.sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || natural(a.floor_name, b.floor_name));
    const i = floors.findIndex(f => String(f._id) === String(req.params.id));
    if (i < 0) return res.status(404).send("Floor not found.");
    const j = req.body.dir === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < floors.length) [floors[i], floors[j]] = [floors[j], floors[i]];
    for (let k = 0; k < floors.length; k++) await Floor.updateOne({ _id: floors[k]._id }, { $set: { sortOrder: (k + 1) * 10 } });
    res.redirect("/user/floors");
  } catch (err) {
    console.error("Move floor error:", err.message);
    fail(res, "/user/floors", "The order could not be saved. Please try again.");
  }
});

/* ── Listing ↔ property (free beds on hostelnode.com) ──────── */
async function myListing(req) {
  return isId(String(req.params.id || "")) ? Listing.findOne({ _id: req.params.id, owner: req.user.id }) : null;
}

router.get("/listing/:id/link", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const listing = await myListing(req);
    if (!listing) return res.status(404).send("Listing not found.");
    const user = await Owner.findById(req.user.id);
    const hostels = await Hostel.find({ owner: req.user.id }, { hostelName: 1, hostelId: 1 }).lean();
    const pickId = isId(String(req.query.hostel || "")) ? String(req.query.hostel) : (listing.linkedHostel ? String(listing.linkedHostel) : (hostels.length === 1 ? String(hostels[0]._id) : ""));
    const hostel = hostels.find(h => String(h._id) === pickId) || null;
    let rows = [], rooms = [];
    if (hostel) {
      const map = await buildBedMap(req.user.id, hostel._id);
      rooms = map.rooms;
      rows = (listing.rooms || []).map((lr, i) => {
        const matched = roomsForType(lr, rooms.map(r => ({ ...r, _id: r.id, sharing_capacity: r.capacity })));
        return { i, type: lr.type, price: lr.price, auto: !(lr.roomIds || []).length, picked: (lr.roomIds || []).map(String), cap: typeCapacity(lr.type),
          matched: matched.map(r => ({ id: r.id, number: r.number })), free: matched.reduce((s, r) => s + r.free, 0) };
      });
    }
    res.render("rooms/listingLink.ejs", { user, listing, hostels, hostel, rows, rooms, flash: flash(req) });
  } catch (err) {
    console.error("Listing link page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/listing/:id/link", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const url = `/user/listing/${encodeURIComponent(req.params.id)}/link`;
  try {
    const listing = await myListing(req);
    if (!listing) return res.status(404).send("Listing not found.");
    if (req.body.unlink === "1") {
      const set = { linkedHostel: null, freeBeds: null, bedsUpdatedAt: null };
      (listing.rooms || []).forEach((_, i) => { set[`rooms.${i}.freeBeds`] = null; set[`rooms.${i}.roomIds`] = []; });
      await Listing.updateOne({ _id: listing._id, owner: req.user.id }, { $set: set });
      return res.redirect(`/user/my-listings`);
    }
    const hostel = isId(String(req.body.hostel || "")) ? await Hostel.findOne({ _id: req.body.hostel, owner: req.user.id }) : null;
    if (!hostel) return fail(res, url, "Choose one of your properties.");
    const myRoomIds = new Set((await Room.find({ user: req.user.id, hostel: hostel._id }, { _id: 1 }).lean()).map(r => String(r._id)));
    const set = { linkedHostel: hostel._id };
    (listing.rooms || []).forEach((_, i) => {
      const picked = [].concat(req.body[`pick${i}`] || []).map(String).filter(id => myRoomIds.has(id));
      set[`rooms.${i}.roomIds`] = req.body[`auto${i}`] === "1" ? [] : picked;
    });
    await Listing.updateOne({ _id: listing._id, owner: req.user.id }, { $set: set });
    await refreshListings(hostel._id);
    res.redirect(`/user/my-listings?linked=1`);
  } catch (err) {
    console.error("Listing link save error:", err.message);
    fail(res, url, "The link could not be saved. Please try again.");
  }
});

module.exports = router;
