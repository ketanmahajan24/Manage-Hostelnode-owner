/* ============================================================
   routes/tenantsRoutes.js  —  Property Operations Phase 3: tenants and admissions
   Mounted at /user in app.js, before the older tenant routes in userRoutes.js.

     GET  /members                        Tenants: Living / Moving out / Moved out, search, filters
     GET  /newmember                      Add tenant: 3 steps (Person · Room and money · Check)
     POST /newMember                      admit (from a lead or walk-in)
     GET  /tenants/:id                    tenant page (Overview, Payments, Documents, History)
     POST /tenants/:id/person             edit personal details
     POST /tenants/:id/stay               edit rent, due day, deposit amount
     POST /tenants/:id/deposit            record deposit received
     POST /tenants/:id/notice             give notice (leaving date)
     POST /tenants/:id/notice/cancel      cancel notice
     GET  /tenants/:id/move-out           settlement screen
     POST /tenants/:id/move-out           move out + settlement slip
     POST /tenants/:id/undo-move-out      undo within 24 hours
     GET  /tenants/:id/slip.pdf           settlement slip PDF
     POST /tenants/:id/slip/send          send the slip on WhatsApp (when its template is set)
     POST /tenants/:id/documents          upload a document (private)
     GET  /tenants/:id/documents/:docId   open a document (only this owner)
     POST /tenants/:id/documents/:docId/delete

   Old addresses (/activeMember, /member-edit/:id/edit, search) open the new pages.
   Every query is limited to the logged-in owner's own tenants.
============================================================ */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const moment = require("moment-timezone");

const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const Hostel = require("../models/hostel");
const Floor = require("../models/floor");
const Room = require("../models/room");
const Member = require("../models/member");
const Payment = require("../models/payment");
const { TZ, LIVING, NOT_REMOVED, isId, escapeRegex, syncRoomAndFloor } = require("../utils/tenantOps");
const { natural, bedRent, tenantRent, ensureBeds, buildBedMap } = require("../utils/beds");
const T = require("../utils/tenants");
const { loadOwnedEnquiry, closeEnquiryAfterConvert, indianMobile } = require("../utils/leads.js");
const { withLocks } = require("../utils/locks");

/* ── small helpers ─────────────────────────────────────────── */
const clean = (s, max = 100) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").trim().replace(/<[^>]*>/g, "").slice(0, max) : "");
function moneyIn(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}
const MOBILE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const GENDERS = ["Male", "Female", "Other"];
const MODES = { cash: "Cash", upi: "UPI", bank: "Bank transfer" };
const ymd = d => (d && !isNaN(new Date(d)) ? moment(d).tz(TZ).format("YYYY-MM-DD") : "");
// A date typed in a form (YYYY-MM-DD), as that day in India time. null if empty or not a date.
function dateIn(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const m = moment.tz(s, "YYYY-MM-DD", true, TZ);
  return m.isValid() ? m.toDate() : null;
}
const todayIST = () => moment().tz(TZ).startOf("day");
const back = (res, url, msg) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const fail = (res, url, msg) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}err=${encodeURIComponent(msg)}`);
const flash = req => ({ msg: clean(req.query.msg || "", 240), err: clean(req.query.err || "", 240) });
const needHostel = (req, res, next) => (res.locals.selectedHostel && res.locals.selectedHostel._id ? next() : res.redirect("/user"));
const H = res => res.locals.selectedHostel._id;
const page = id => `/user/tenants/${id}`;

// One of this owner's tenants (not removed). Payments populated when asked.
async function myTenant(req, id, withPayments = false) {
  if (!isId(String(id || ""))) return null;
  const q = Member.findOne({ _id: id, user: req.user.id, ...NOT_REMOVED });
  return withPayments ? q.populate("payments") : q;
}

/* ── old addresses → new pages ─────────────────────────────── */
router.get("/activeMember", jwtAuthMiddleware, (req, res) => res.redirect("/user/members"));
router.get("/member-edit/:id/edit", jwtAuthMiddleware, (req, res) => res.redirect(isId(req.params.id) ? page(req.params.id) : "/user/members"));
router.post("/member/search", jwtAuthMiddleware, (req, res) => res.redirect("/user/members?q=" + encodeURIComponent(clean(req.body.name || "", 60))));

/* ════════════════ Tenants list ════════════════ */
router.get("/members", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    const userId = req.user.id, hostel = H(res);
    const tab = ["living", "notice", "out"].includes(req.query.tab) ? req.query.tab : "living";
    const q = clean(req.query.q || "", 60);
    const floorId = isId(String(req.query.floor || "")) ? String(req.query.floor) : "";
    const onlyDues = req.query.dues === "1", onlyNoKyc = req.query.kyc === "none";

    const [user, floors, rooms, living, outCount] = await Promise.all([
      Owner.findById(userId),
      Floor.find({ user: userId, hostel }, { floor_name: 1, sortOrder: 1 }).lean(),
      Room.find({ user: userId, hostel }, { room_number: 1, floor_id: 1 }).lean(),
      Member.find({ user: userId, hostel, ...LIVING }).populate("payments"),
      Member.countDocuments({ user: userId, hostel, ...NOT_REMOVED, leftDate: { $ne: null } }),
    ]);
    floors.sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || natural(a.floor_name, b.floor_name));
    const roomOf = new Map(rooms.map(r => [String(r._id), r]));
    const floorName = new Map(floors.map(f => [String(f._id), f.floor_name]));

    // Summary (always for everyone living here, whatever the filters).
    const livingMoney = living.map(m => ({ m, money: T.moneyOf(m) }));
    const owing = livingMoney.filter(x => x.money.due > 0);
    const summary = {
      living: living.length,
      notice: living.filter(m => m.leavingDate).length,
      out: outCount,
      dueTotal: owing.reduce((s, x) => s + x.money.due, 0),
      dueCount: owing.length,
      noKyc: living.filter(m => m.kycStatus !== "verified").length,
    };

    // The tab's tenants.
    let list;
    if (tab === "out") {
      list = (await Member.find({ user: userId, hostel, ...NOT_REMOVED, leftDate: { $ne: null } }).populate("payments").sort({ leftDate: -1 }).limit(300))
        .map(m => ({ m, money: T.moneyOf(m) }));
    } else {
      list = tab === "notice" ? livingMoney.filter(x => x.m.leavingDate) : livingMoney;
    }
    if (q) {
      const digits = q.replace(/\D/g, "");
      const re = new RegExp(escapeRegex(q), "i");
      list = list.filter(({ m }) => re.test(m.name || "") || (digits.length >= 3 && String(m.mobileNo || "").includes(digits)) || re.test(String(m.assignedRoom || "")));
    }
    if (floorId) list = list.filter(({ m }) => String((roomOf.get(String(m.assignedRoom_id)) || {}).floor_id || "") === floorId);
    if (onlyDues) list = list.filter(x => x.money.due > 0);
    if (onlyNoKyc) list = list.filter(x => x.m.kycStatus !== "verified");
    if (tab !== "out") list.sort((a, b) => natural(a.m.assignedRoom || "", b.m.assignedRoom || "") || natural(a.m.bedLabel || "", b.m.bedLabel || ""));

    const rows = list.map(({ m, money }) => {
      const room = roomOf.get(String(m.assignedRoom_id));
      return {
        id: String(m._id), name: m.name, initials: T.initials(m.name), tone: T.toneOf(m._id),
        mobile: String(m.mobileNo || ""), mobileMasked: T.maskMobile(m.mobileNo),
        since: T.day(m.joiningDate), left: T.day(m.leftDate),
        room: m.assignedRoom || "—", bed: m.bedLabel || "", floor: room ? floorName.get(String(room.floor_id)) || "" : "",
        rent: 0,
        dueDay: T.dueDayOf(m), leaving: m.leavingDate && !m.leftDate ? T.day(m.leavingDate) : "",
        leavingPassed: !!(m.leavingDate && !m.leftDate && moment(m.leavingDate).tz(TZ).isBefore(todayIST())),
        fromLead: !!m.fromEnquiry, kyc: m.kycStatus === "verified", money,
      };
    });
    // Rent shown in the list: the tenant's own rent, else their bed's rent.
    const roomsFull = await Room.find({ _id: { $in: list.map(x => x.m.assignedRoom_id).filter(Boolean) } }, { room_fees: 1, beds: 1 }).lean();
    const fullOf = new Map(roomsFull.map(r => [String(r._id), r]));
    list.forEach(({ m }, i) => { rows[i].rent = tenantRent(m, fullOf.get(String(m.assignedRoom_id)) || { room_fees: 0, beds: [] }); });

    const hasBeds = rooms.length > 0;
    res.render("tenants/list.ejs", {
      user, rows, summary, tab, q, floorId, onlyDues, onlyNoKyc, floors: floors.map(f => ({ id: String(f._id), name: f.floor_name })),
      hostelName: res.locals.selectedHostel.hostelName || "", hasBeds, flash: flash(req), T,
    });
  } catch (err) {
    console.error("Tenants list error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/* ════════════════ Add tenant (admission) ════════════════ */

// Free beds of the selected property, for the bed picker.
async function freeBeds(userId, hostelId) {
  const map = await buildBedMap(userId, hostelId);
  const out = [];
  for (const f of map.floors) for (const r of f.rooms) for (const b of r.beds) {
    if (b.member || b.blocked) continue;
    out.push({ value: `${r.id}:${b.label}`, roomId: r.id, label: b.label, room: r.number, floor: f.name, rent: b.rent,
      sharing: r.capacity, roomType: r.roomType || "" });
  }
  return { beds: out, totalBeds: map.total };
}

async function renderAdmit(req, res, { values = {}, errors = {}, status = 200 } = {}) {
  const userId = req.user.id, hostel = H(res);
  const [user, { beds, totalBeds }] = await Promise.all([Owner.findById(userId), freeBeds(userId, hostel)]);
  // From a lead (Leads & CRM "Admit as tenant"): fill in what the student gave us.
  let lead = null;
  const enquiryId = String(values.enquiryId || req.query.enquiry || "");
  if (enquiryId) {
    const e = await loadOwnedEnquiry(enquiryId, userId).catch(() => null);
    if (e) {
      const st = e.student || {};
      lead = { id: String(e._id), name: [st.firstName, st.lastName].filter(Boolean).join(" "), listing: e.listing?.title || "", roomType: e.roomType || "" };
      if (!values._posted) {
        Object.assign(values, {
          name: lead.name, mobileNo: indianMobile(st.phone), email: st.email || "", gender: GENDERS.includes(st.gender) ? st.gender : "",
          dob: ymd(st.dob), profession: [st.collegeName, st.course].filter(Boolean).join(", "),
        });
      }
    }
  }
  // A bed picked on the bed map (?room=&bed=).
  if (!values.bed && req.query.room && req.query.bed) {
    const want = `${String(req.query.room)}:${String(req.query.bed).toUpperCase()}`;
    if (beds.some(b => b.value === want)) values.bed = want;
  }
  const step = errors._step || (Object.keys(errors).length ? 1 : 1);
  res.status(status).render("tenants/admit.ejs", {
    user, beds, totalBeds, lead, values, errors, step, today: ymd(new Date()),
    hostelName: res.locals.selectedHostel.hostelName || "", T, welcomeOn: T.welcomeOn(),
  });
}

router.get("/newmember", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  try {
    await renderAdmit(req, res);
  } catch (err) {
    console.error("Add tenant page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

// Which step each field is on, to open the form where the first problem is.
const STEP_OF = { name: 1, mobileNo: 1, email: 1, gender: 1, dob: 1, guardianMobile: 1, bed: 2, joiningDate: 2, rent: 2, dueDay: 2, firstCharge: 2, earlier: 2, deposit: 2, depositMode: 2, firstPaid: 2, firstAmount: 2 };

async function admitTenant(req, res) {
  const userId = req.user.id, hostel = H(res);
  const b = req.body.member || {};
  const values = {
    _posted: true, enquiryId: clean(req.body.enquiryId || "", 30),
    name: clean(b.name || "", 100), mobileNo: String(b.mobileNo || "").replace(/\D/g, "").slice(-10), email: clean(b.email || "", 120).toLowerCase(),
    gender: GENDERS.includes(b.gender) ? b.gender : "", dob: clean(b.dob || "", 10), profession: clean(b.profession || "", 100),
    address: clean(b.address || "", 500), guardianName: clean(b.guardianName || "", 100), guardianMobile: String(b.guardianMobile || "").replace(/\D/g, "").slice(-10),
    emergencyContact: clean(b.emergencyContact || "", 120),
    bed: clean(b.bed || (b.assignedRoom_id ? `${b.assignedRoom_id}:${b.bedLabel || ""}` : ""), 40),
    joiningDate: clean(b.joiningDate || "", 10), rent: clean(String(b.rent ?? ""), 12), dueDay: clean(String(b.dueDay ?? ""), 2),
    deposit: clean(String(b.deposit ?? ""), 12), depositMode: ["cash", "upi", "later"].includes(b.depositMode) ? b.depositMode : "",
    firstPaid: ["full", "part", "none"].includes(b.firstPaid) ? b.firstPaid : "", firstAmount: clean(String(b.firstAmount ?? ""), 12),
    firstMode: ["cash", "upi"].includes(b.firstMode) ? b.firstMode : "cash",
    firstCharge: clean(String(b.firstCharge ?? ""), 12), earlier: ["paid", "due"].includes(b.earlier) ? b.earlier : "",
  };
  // The older one-page form (still open in someone's browser during the update, or a saved draft):
  // room only, no payment questions. It saves as before: first free bed, bed rent, nothing paid yet.
  const legacy = b.bed === undefined && b.assignedRoom_id !== undefined;
  if (legacy) {
    if (!values.firstPaid) values.firstPaid = "none";
    if (!values.deposit) values.deposit = "0";
    if (!values.earlier) values.earlier = "paid";
  }
  const errors = {};
  const bad = (k, msg) => { if (!errors[k]) errors[k] = msg; };
  try {
    // Step 1 — person
    if (!values.name) bad("name", "Enter the tenant's name.");
    if (!MOBILE.test(values.mobileNo)) bad("mobileNo", "Enter a 10-digit mobile number.");
    if (values.email && !EMAIL.test(values.email)) bad("email", "Check the email address, or leave it empty.");
    let dob = null;
    if (values.dob) { dob = dateIn(values.dob); if (!dob || dob > new Date() || moment().diff(dob, "years") > 100) bad("dob", "Enter a real date of birth, or leave it empty."); }
    if (values.guardianMobile && !MOBILE.test(values.guardianMobile)) bad("guardianMobile", "Enter a 10-digit mobile number, or leave it empty.");

    // Step 2 — bed, rent, deposit
    const [roomId, label] = values.bed.split(":");
    const room = isId(String(roomId || "")) ? await Room.findOne({ _id: roomId, user: userId, hostel }) : null;
    let bed = null;
    if (!room) bad("bed", "Choose a free bed.");
    else {
      const beds = await ensureBeds(room.toObject());
      bed = beds.find(x => x.label === String(label || "").toUpperCase()) || null;
      if (legacy && (!bed || bed.member || bed.blocked)) bed = beds.find(x => !x.member && !x.blocked) || null;   // old form: first free bed
      if (!bed || bed.member || bed.blocked) { bad("bed", legacy ? "This room is full. Please choose another room." : "That bed is not free any more. Choose another."); bed = null; }
      if (bed && legacy && values.rent === "") values.rent = String(bed.rent);
    }
    let joiningDate = values.joiningDate ? dateIn(values.joiningDate) : todayIST().toDate();
    if (!joiningDate || Math.abs(joiningDate - Date.now()) > 366 * 864e5) { bad("joiningDate", "Enter a joining date within a year from today."); joiningDate = null; }
    const rent = moneyIn(values.rent);   // (for the old form this is the bed's rent, set above)
    if (rent === null) bad("rent", "Enter the monthly rent (0 or more).");
    let dueDay = values.dueDay === "" ? (joiningDate ? moment(joiningDate).tz(TZ).date() : null) : Number(values.dueDay);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) bad("dueDay", "Choose a due day from 1 to 31.");
    const deposit = values.deposit === "" ? 0 : moneyIn(values.deposit);
    if (deposit === null) bad("deposit", "Enter the deposit as a number (0 if none).");
    else if (deposit > 0 && !values.depositMode) bad("depositMode", "Say whether the deposit was paid now (cash or UPI) or will be paid later.");
    if (!values.firstPaid) bad("firstPaid", "Say whether the first month's rent was paid now.");
    // Which months are charged now (see T.rentPlan): the first rent period, and for a tenant who
    // joined in an earlier month, the months before it only if the owner says they are still due.
    const plan = joiningDate && Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 ? T.rentPlan({ joiningDate, dueDay }) : null;
    let firstCharge = rent;
    if (rent !== null && values.firstCharge !== "") {
      firstCharge = moneyIn(values.firstCharge);
      if (firstCharge === null || (rent > 0 && firstCharge <= 0)) bad("firstCharge", "Enter the rent for the first period (more than 0).");
    }
    if (plan && plan.earlier.length && !values.earlier) bad("earlier", `Say whether the rent for ${plan.earlier[0].label}${plan.earlier.length > 1 ? " – " + plan.earlier[plan.earlier.length - 1].label : ""} was already paid or should be added to dues.`);
    let firstAmount = 0;
    if (firstCharge !== null && rent !== null) {
      if (values.firstPaid === "full") firstAmount = firstCharge;
      else if (values.firstPaid === "part") {
        firstAmount = moneyIn(values.firstAmount);
        if (firstAmount === null || firstAmount <= 0 || firstAmount > firstCharge) bad("firstAmount", `Enter the amount paid now (up to ${T.inr(firstCharge)}).`);
      }
    }

    // Same person already living here?
    if (!errors.mobileNo) {
      const twin = await Member.findOne({ user: userId, hostel, ...LIVING, mobileNo: values.mobileNo }, { name: 1, assignedRoom: 1, assignedRoom_id: 1 }).lean();
      // The same form sent twice in a moment (double click): show the tenant just admitted.
      // Anything else (later, or a different bed) is told the tenant already lives here.
      if (twin && twin.name === values.name && String(twin.assignedRoom_id) === String(values.bed.split(":")[0]) && Date.now() - twin._id.getTimestamp() < 15e3) return res.redirect(page(twin._id));
      if (twin) bad("mobileNo", `${twin.name} with this mobile number already lives here (room ${twin.assignedRoom || "—"}).`);
    }

    if (Object.keys(errors).length) {
      errors._step = Math.min(...Object.keys(errors).map(k => STEP_OF[k] || 1));
      return renderAdmit(req, res, { values, errors, status: 400 });
    }

    const roomRent = bedRent(room, bed.label);
    const depositPaid = values.depositMode === "cash" || values.depositMode === "upi" ? deposit : 0;
    const enquiry = values.enquiryId ? await loadOwnedEnquiry(values.enquiryId, userId).catch(() => null) : null;
    const newMember = new Member({
      user: userId, hostel, assignedRoom_id: room._id, assignedRoom: room.room_number, bedLabel: bed.label, status: "Active",
      name: values.name, mobileNo: values.mobileNo, email: values.email, gender: values.gender, dob, profession: values.profession,
      address: values.address, guardianName: values.guardianName, guardianMobile: values.guardianMobile, emergencyContact: values.emergencyContact,
      fatherName: "", aadharNo: "", joiningDate, dueDay,
      rent: rent === roomRent ? null : rent,
      depositAmount: deposit, depositPaid, depositMode: depositPaid ? MODES[values.depositMode] : "", depositPaidAt: depositPaid ? new Date() : null,
      fromEnquiry: enquiry ? enquiry._id : null,
    });
    await newMember.validate();

    // Rent charged now, each marked with its month so the monthly job never charges it again:
    // earlier months (only when the owner said they are still due), then the first rent period.
    // Then what was paid today.
    const made = [];
    const charge = async (amount, date, key) => {
      const c = await new Payment({ user: userId, memberId: newMember._id, roomId: room._id, roomFees: amount, totalFees: amount, dueAmount: amount,
        paymentDate: date, payableDate: date, chargeMonth: key }).save();
      made.push(c._id);
    };
    try {
      if (rent > 0 && values.earlier === "due") {
        const amounts = plan.earlierAmounts(rent);   // the joining month pro-rata, then full months
        for (let i = 0; i < plan.earlier.length; i++) if (amounts[i] > 0) await charge(amounts[i], plan.earlier[i].date, plan.earlier[i].key);
      }
      if (firstCharge > 0) await charge(firstCharge, plan.first.date, plan.first.key);
      if (firstAmount > 0) {
        const paid = await new Payment({ user: userId, memberId: newMember._id, amountPaid: firstAmount, paymentMode: MODES[values.firstMode],
          paymentDate: new Date(), status: "Paid" }).save();
        made.push(paid._id);
      }
      newMember.payments.push(...made);
      await newMember.save();
    } catch (e) {
      await Payment.deleteMany({ _id: { $in: made } }).catch(() => {});
      throw e;
    }
    // Two admissions of the same person, or into the last bed, at the same moment (two tabs, a retry):
    // the later one is taken back and the owner is shown the tenant who was saved.
    const [twins, inRoom] = await Promise.all([
      Member.find({ user: userId, hostel, ...LIVING, mobileNo: values.mobileNo }, { _id: 1 }).sort({ _id: 1 }).lean(),
      Member.find({ assignedRoom_id: room._id, ...LIVING }, { _id: 1 }).sort({ _id: 1 }).lean(),
    ]);
    const capacity = Number((await Room.findById(room._id, { sharing_capacity: 1 }).lean() || {}).sharing_capacity) || 0;
    const overFull = inRoom.length > capacity && inRoom.slice(capacity).some(x => String(x._id) === String(newMember._id));
    if ((twins.length > 1 && String(twins[0]._id) !== String(newMember._id)) || overFull) {
      await Member.deleteOne({ _id: newMember._id });
      await Payment.deleteMany({ _id: { $in: made }, memberId: newMember._id });
      await syncRoomAndFloor(room._id);
      if (twins.length > 1 && String(twins[0]._id) !== String(newMember._id)) return res.redirect(page(twins[0]._id));
      errors.bed = "That bed was just taken. Choose another.";
      errors._step = 2;
      return renderAdmit(req, res, { values, errors, status: 409 });
    }
    // The same bed given twice at the same moment: the later one gets the next free bed.
    await ensureBeds((await Room.findById(room._id).lean()) || room.toObject()).catch(() => {});
    await syncRoomAndFloor(room._id);
    if (enquiry) await closeEnquiryAfterConvert(String(enquiry._id), userId, newMember._id);

    const saved = await Member.findById(newMember._id, { bedLabel: 1, hostel: 1 }).lean();
    await T.logEvent(req, newMember, "admitted",
      `Admitted to room ${room.room_number} · bed ${saved.bedLabel}${enquiry ? " from a lead" : ""}`,
      [`rent ${T.inr(rent)} on the ${T.ordinal(dueDay)}`,
        firstCharge !== rent ? `first period ${T.inr(firstCharge)}` : "",
        plan.earlier.length ? `${plan.earlier.length} earlier month${plan.earlier.length === 1 ? "" : "s"} ${values.earlier === "due" ? "added to dues" : "already paid"}` : "",
        deposit ? `deposit ${T.inr(deposit)}${depositPaid ? " " + MODES[values.depositMode].toLowerCase() : " (to be paid)"}` : "no deposit"].filter(Boolean).join(" · "));

    // Welcome on WhatsApp (only when its template is set up). Not waited for.
    const welcome = T.welcomeOn();
    if (welcome) T.sendWelcome({ phone: values.mobileNo, name: values.name, property: res.locals.selectedHostel.hostelName || "your PG",
      room: room.room_number, bed: saved.bedLabel, rent, dueDay }).catch(() => {});

    back(res, page(newMember._id), `${values.name} admitted to room ${room.room_number}, bed ${saved.bedLabel}.${welcome ? " Welcome message sent on WhatsApp." : ""}`);
  } catch (err) {
    console.error("Admit tenant error:", err.message);
    errors._form = "The tenant could not be saved. Please try again.";
    try { return await renderAdmit(req, res, { values, errors, status: 500 }); }
    catch { return res.status(500).send("The tenant could not be saved. Please try again."); }
  }
}

// One admission at a time per room and per mobile number in the property (two tabs, a double click, two staff).
router.post("/newMember", jwtAuthMiddleware, attachHostel, needHostel, async (req, res) => {
  const b = req.body.member || {};
  const roomId = String(b.bed || b.assignedRoom_id || "").split(":")[0];
  const mobile = String(b.mobileNo || "").replace(/\D/g, "").slice(-10);
  try {
    const keys = [isId(roomId) ? `room:${roomId}` : "", mobile ? `mobile:${H(res)}:${mobile}` : ""];
    // Busy for a moment (the other save takes well under a second): wait and try again.
    for (let i = 0; i < 20; i++) {
      const r = await withLocks(keys, () => admitTenant(req, res));
      if (!r.busy) return;
      await new Promise(z => setTimeout(z, 250));
    }
    res.status(409).send("Another change to this room is being saved right now. Go back and press Admit tenant again.");
  } catch (err) {
    console.error("Admit tenant (lock) error:", err.message);
    if (!res.headersSent) res.status(500).send("The tenant could not be saved. Please try again.");
  }
});

/* ════════════════ Tenant page ════════════════ */
router.get("/tenants/:id", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await myTenant(req, req.params.id, true);
    if (!m) return res.status(404).send("Tenant not found.");
    const tab = ["overview", "payments", "documents", "history"].includes(req.query.tab) ? req.query.tab : "overview";
    const [user, hostel, room, history] = await Promise.all([
      Owner.findById(req.user.id),
      Hostel.findById(m.hostel, { hostelName: 1 }).lean(),
      m.assignedRoom_id ? Room.findById(m.assignedRoom_id).lean() : null,
      T.historyOf(m, req.user.id, tab === "history" ? 300 : 5),
    ]);
    const floor = room && room.floor_id ? await Floor.findById(room.floor_id, { floor_name: 1 }).lean() : null;
    const sameHostel = !!(res.locals.selectedHostel && String(res.locals.selectedHostel._id) === String(m.hostel));
    const status = T.statusOf(m);
    const living = status.key !== "out";
    // Free beds to move to (same property), for "Change room".
    let moveTo = [];
    if (living && sameHostel) moveTo = (await freeBeds(req.user.id, m.hostel)).beds;
    // The tenant's own ledger (the same entries every due/paid figure uses).
    const payments = tab === "payments" ? (m.payments || []).filter(p => p && typeof p === "object").map(p => (p.toObject ? p.toObject() : p))
      .sort((a, b) => (new Date(b.paymentDate || 0) - new Date(a.paymentDate || 0)) || String(b._id).localeCompare(String(a._id))).slice(0, 300) : [];
    const s = m.settlement && m.settlement.at ? m.settlement : null;
    const canUndo = !!(s && !s.undoneAt && m.leftDate && Date.now() - new Date(s.at) < 24 * 3600e3);
    const ownRent = typeof m.rent === "number";
    const leavingPassed = !!(m.leavingDate && !m.leftDate && moment(m.leavingDate).tz(TZ).isBefore(todayIST()));
    res.render("tenants/profile.ejs", {
      user, m, tab, room, floor, hostel, sameHostel, status, living, moveTo, payments, history, settlement: s, canUndo,
      money: T.moneyOf(m), rent: tenantRent(m, room || { room_fees: 0, beds: [] }), bedRentNow: room ? bedRent(room, m.bedLabel) : null, ownRent,
      dueDay: T.dueDayOf(m), leavingPassed, flash: flash(req), T, today: ymd(new Date()), slipWhatsApp: require("../utils/settlementPdf").slipOn(),
    });
  } catch (err) {
    console.error("Tenant page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

// Only for a tenant of the property being worked on (actions change beds and rent there).
async function actionable(req, res, { living = true } = {}) {
  const m = await myTenant(req, req.params.id);
  if (!m) { res.status(404).send("Tenant not found."); return null; }
  if (!res.locals.selectedHostel || String(res.locals.selectedHostel._id) !== String(m.hostel)) { fail(res, page(m._id), "Switch to this tenant's property to make changes."); return null; }
  if (living && m.leftDate) { fail(res, page(m._id), `${m.name} has moved out.`); return null; }
  return m;
}

router.post("/tenants/:id/person", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await actionable(req, res, { living: false });
    if (!m) return;
    const b = req.body || {};
    const name = clean(b.name || "", 100), mobileNo = String(b.mobileNo || "").replace(/\D/g, "").slice(-10);
    const email = clean(b.email || "", 120).toLowerCase(), guardianMobile = String(b.guardianMobile || "").replace(/\D/g, "").slice(-10);
    if (!name) return fail(res, page(m._id), "Enter the tenant's name.");
    if (!MOBILE.test(mobileNo)) return fail(res, page(m._id), "Enter a 10-digit mobile number.");
    if (email && !EMAIL.test(email)) return fail(res, page(m._id), "Check the email address, or leave it empty.");
    if (guardianMobile && !MOBILE.test(guardianMobile)) return fail(res, page(m._id), "Enter the guardian's 10-digit mobile number, or leave it empty.");
    let dob = null;
    if (b.dob) { dob = dateIn(b.dob); if (!dob || dob > new Date()) return fail(res, page(m._id), "Enter a real date of birth, or leave it empty."); }
    if (!m.leftDate && mobileNo !== m.mobileNo) {
      const twin = await Member.findOne({ _id: { $ne: m._id }, user: req.user.id, hostel: m.hostel, ...LIVING, mobileNo }, { name: 1 }).lean();
      if (twin) return fail(res, page(m._id), `${twin.name} already lives here with this mobile number.`);
    }
    const set = { name, mobileNo, email, gender: GENDERS.includes(b.gender) ? b.gender : "", dob, profession: clean(b.profession || "", 100),
      address: clean(b.address || "", 500), guardianName: clean(b.guardianName || "", 100), guardianMobile, emergencyContact: clean(b.emergencyContact || "", 120) };
    await Member.updateOne({ _id: m._id, user: req.user.id }, { $set: set });
    const changed = Object.keys(set).filter(k => String(set[k] ?? "") !== String(m[k] ?? "") && !(k === "dob" && ymd(set.dob) === ymd(m.dob)));
    if (changed.length) await T.logEvent(req, m, "details", "Personal details updated", changed.length <= 3 ? "changed: " + changed.join(", ") : `${changed.length} details changed`);
    back(res, page(m._id), "Details saved.");
  } catch (err) {
    console.error("Tenant details error:", err.message);
    fail(res, page(req.params.id), "The details could not be saved. Please try again.");
  }
});

router.post("/tenants/:id/stay", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await actionable(req, res);
    if (!m) return;
    const room = m.assignedRoom_id ? await Room.findById(m.assignedRoom_id, { room_fees: 1, beds: 1 }).lean() : null;
    const rent = moneyIn(req.body.rent), dueDay = Number(req.body.dueDay), deposit = req.body.deposit === "" ? 0 : moneyIn(req.body.deposit);
    if (rent === null) return fail(res, page(m._id), "Enter the monthly rent (0 or more).");
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return fail(res, page(m._id), "Choose a due day from 1 to 31.");
    if (deposit === null) return fail(res, page(m._id), "Enter the deposit as a number (0 if none).");
    const oldRent = tenantRent(m, room || { room_fees: 0, beds: [] }), oldDay = T.dueDayOf(m), oldDeposit = Number(m.depositAmount) || 0;
    const bedNow = room ? bedRent(room, m.bedLabel) : null;
    const set = { dueDay, depositAmount: deposit };
    if (rent !== oldRent) set.rent = rent === bedNow ? null : rent;
    await Member.updateOne({ _id: m._id, user: req.user.id }, { $set: set });
    const said = [];
    if (rent !== oldRent) { said.push(`rent ${T.inr(rent)} from the next rent`); await T.logEvent(req, m, "rent", `Rent changed ${T.inr(oldRent)} → ${T.inr(rent)}`, "from the next monthly rent"); }
    if (dueDay !== oldDay) { said.push(`due on the ${T.ordinal(dueDay)}`); await T.logEvent(req, m, "dueDay", `Rent due day changed to the ${T.ordinal(dueDay)}`, oldDay ? `was the ${T.ordinal(oldDay)}` : ""); }
    if (deposit !== oldDeposit) { said.push(`deposit ${T.inr(deposit)}`); await T.logEvent(req, m, "deposit", `Deposit set to ${T.inr(deposit)}`, `was ${T.inr(oldDeposit)}`); }
    back(res, page(m._id), said.length ? "Saved: " + said.join(", ") + "." : "Nothing changed.");
  } catch (err) {
    console.error("Tenant stay error:", err.message);
    fail(res, page(req.params.id), "That change could not be saved. Please try again.");
  }
});

router.post("/tenants/:id/deposit", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await actionable(req, res);
    if (!m) return;
    const amount = moneyIn(req.body.amount), mode = MODES[req.body.mode];
    const owed = Math.max(0, (Number(m.depositAmount) || 0) - (Number(m.depositPaid) || 0));
    if (!mode || mode === MODES.bank) return fail(res, page(m._id), "Choose cash or UPI.");
    if (amount === null || amount <= 0) return fail(res, page(m._id), "Enter the deposit amount received.");
    if (m.depositAmount && amount > owed) return fail(res, page(m._id), `Only ${T.inr(owed)} of the deposit is left to receive.`);
    // Only adds when the amount still owed has not changed since the page was opened (no double counting).
    // (tenants added before Phase 3 have no depositPaid saved at all: that counts as 0)
    const r = await Member.updateOne({ _id: m._id, user: req.user.id, depositPaid: m.depositPaid ? m.depositPaid : { $in: [0, null] } },
      { $set: { depositPaid: (Number(m.depositPaid) || 0) + amount, depositMode: mode, depositPaidAt: new Date(), ...(m.depositAmount ? {} : { depositAmount: amount }) } });
    if (!r.modifiedCount) return fail(res, page(m._id), "The deposit changed a moment ago. Please check and try again.");
    await T.logEvent(req, m, "deposit", `Deposit received ${T.inr(amount)} · ${mode.toLowerCase()}`);
    back(res, page(m._id), `Deposit of ${T.inr(amount)} recorded.`);
  } catch (err) {
    console.error("Tenant deposit error:", err.message);
    fail(res, page(req.params.id), "The deposit could not be recorded. Please try again.");
  }
});

/* ── notice ── */
router.post("/tenants/:id/notice", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await actionable(req, res);
    if (!m) return;
    const d = dateIn(req.body.leavingDate);
    const today = todayIST();
    if (!d || moment(d).isAfter(today.clone().add(1, "year"))) return fail(res, page(m._id), "Choose a leaving date (up to a year from today).");
    if (moment(d).isBefore(today)) return fail(res, page(m._id), `Choose today or a later date. If ${m.name} has already left, use Move out.`);
    if (m.joiningDate && d < new Date(m.joiningDate)) return fail(res, page(m._id), "The leaving date is before the joining date.");
    const reason = clean(req.body.reason || "", 60);
    await Member.updateOne({ _id: m._id, user: req.user.id, ...LIVING }, { $set: { leavingDate: d, noticeAt: m.leavingDate ? m.noticeAt : new Date(), noticeReason: reason } });
    await T.logEvent(req, m, "notice", `${m.leavingDate ? "Leaving date changed to" : "Gave notice, leaving on"} ${T.dayYear(d)}`, reason);
    back(res, page(m._id), `${m.name} is leaving on ${T.dayYear(d)}. Their bed shows "Leaving soon"; move them out on the day.`);
  } catch (err) {
    console.error("Tenant notice error:", err.message);
    fail(res, page(req.params.id), "The notice could not be saved. Please try again.");
  }
});

router.post("/tenants/:id/notice/cancel", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await actionable(req, res);
    if (!m) return;
    if (!m.leavingDate) return back(res, page(m._id), "There was no notice to cancel.");
    await Member.updateOne({ _id: m._id, user: req.user.id, ...LIVING }, { $set: { leavingDate: null, noticeAt: null, noticeReason: "" } });
    await T.logEvent(req, m, "noticeCancel", "Notice cancelled, staying on");
    back(res, page(m._id), `Notice cancelled. ${m.name} is staying.`);
  } catch (err) {
    console.error("Tenant notice cancel error:", err.message);
    fail(res, page(req.params.id), "That could not be saved. Please try again.");
  }
});

/* ── move out and settlement ── */
// Settlement slip numbers count up per owner: SL-2026-0001, SL-2026-0002… (never repeated, even at the same moment).
async function nextSlipNo(ownerId, when) {
  const col = Owner.collection;
  const oid = new (require("mongoose").Types.ObjectId)(String(ownerId));
  const start = await Member.countDocuments({ user: ownerId, "settlement.slipNo": { $exists: true, $ne: null } });
  await col.updateOne({ _id: oid, "counters.settlementSlip": { $exists: false } }, { $set: { "counters.settlementSlip": start } });
  const r = await col.findOneAndUpdate({ _id: oid }, { $inc: { "counters.settlementSlip": 1 } }, { returnDocument: "after" });
  const doc = r && r.value !== undefined ? r.value : r;
  const n = Number(doc && doc.counters && doc.counters.settlementSlip) || start + 1;
  return `SL-${moment(when).tz(TZ).format("YYYY")}-${String(n).padStart(4, "0")}`;
}
function settleNumbers(m, deductions) {
  const money = T.moneyOf(m);
  const depositHeld = Math.max(0, Number(m.depositPaid) || 0);
  const dedTotal = deductions.reduce((s, d) => s + d.amount, 0);
  const net = depositHeld + money.advance - money.due - dedTotal;
  return { depositHeld, advance: money.advance, dues: money.due, dedTotal, net };
}

router.get("/tenants/:id/move-out", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const m = await myTenant(req, req.params.id, true);
    if (!m) return res.status(404).send("Tenant not found.");
    if (m.leftDate) return res.redirect(page(m._id));
    if (!res.locals.selectedHostel || String(res.locals.selectedHostel._id) !== String(m.hostel)) return fail(res, page(m._id), "Switch to this tenant's property to move them out.");
    const user = await Owner.findById(req.user.id);
    const leaving = m.leavingDate && moment(m.leavingDate).tz(TZ).isSameOrBefore(todayIST()) ? ymd(m.leavingDate) : ymd(new Date());
    res.render("tenants/moveOut.ejs", { user, m, n: settleNumbers(m, []), leaving, today: ymd(new Date()), minDate: ymd(m.joiningDate), flash: flash(req), T,
      hostelName: res.locals.selectedHostel.hostelName || "" });
  } catch (err) {
    console.error("Move out page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/tenants/:id/move-out", jwtAuthMiddleware, attachHostel, async (req, res) => {
  const url = `${page(req.params.id)}/move-out`;
  try {
    const m0 = await actionable(req, res);
    if (!m0) return;
    const leftOn = dateIn(req.body.leftDate) || todayIST().toDate();
    if (moment(leftOn).isAfter(todayIST())) return fail(res, url, "The move-out date cannot be in the future. Give notice instead.");
    if (m0.joiningDate && leftOn < moment(m0.joiningDate).tz(TZ).startOf("day").toDate()) return fail(res, url, "The move-out date is before the joining date.");
    const labels = [].concat(req.body.dedLabel || []), amounts = [].concat(req.body.dedAmount || []);
    const deductions = [];
    for (let i = 0; i < Math.min(10, Math.max(labels.length, amounts.length)); i++) {
      const label = clean(labels[i] || "", 40), amount = moneyIn(amounts[i]);
      if (!label && (amounts[i] === undefined || String(amounts[i]).trim() === "")) continue;
      if (!label) return fail(res, url, "Give each deduction a name, for example 'Broken chair'.");
      if (amount === null || amount <= 0) return fail(res, url, `Enter the amount for '${label}'.`);
      deductions.push({ label, amount });
    }
    const mode = MODES[req.body.mode] || "Cash";

    const m = await Member.findById(m0._id).populate("payments");
    const n = settleNumbers(m, deductions);

    // 1. Ledger entries: the deposit pays the dues first, then the deductions; money paid in advance is given back.
    const made = [];
    try {
      const pay = async doc => { const p = await new Payment({ user: req.user.id, memberId: m._id, paymentDate: leftOn, ...doc }).save(); made.push(p._id); };
      let left = n.depositHeld;
      const forDues = Math.min(left, n.dues); left -= forDues;
      if (forDues > 0) await pay({ amountPaid: forDues, paymentMode: "Deposit adjusted", status: "Paid" });
      if (n.dedTotal > 0) {
        await pay({ roomId: m.assignedRoom_id, roomFees: n.dedTotal, totalFees: n.dedTotal, dueAmount: n.dedTotal, status: "Due", paymentMode: "Move-out deductions" });
        const forDed = Math.min(left, n.dedTotal); left -= forDed;
        if (forDed > 0) await pay({ amountPaid: forDed, paymentMode: "Deposit adjusted", status: "Paid" });
      }
      if (n.advance > 0 && n.net > 0) await pay({ roomFees: Math.min(n.advance, n.net), totalFees: Math.min(n.advance, n.net), status: "Paid", paymentMode: "Advance refunded" });
    } catch (e) {
      await Payment.deleteMany({ _id: { $in: made } }).catch(() => {});
      throw e;
    }
    // 2. Move out together with the settlement, only once (a second press finds them already moved out).
    let slipNo, moved = null;
    try {
      slipNo = await nextSlipNo(req.user.id, leftOn);
      moved = await Member.findOneAndUpdate({ _id: m._id, user: req.user.id, ...LIVING }, {
        $set: { leftDate: leftOn, status: "Inactive",
          settlement: { at: new Date(), slipNo, depositHeld: n.depositHeld, advance: n.advance, dues: n.dues, deductions, net: n.net, mode: n.net > 0 ? mode : "", paymentIds: made, undoneAt: null } },
        $addToSet: { payments: { $each: made } },
      }, { new: true });
    } catch (e) {
      moved = null;
      console.error("Move out (second step, undone):", e.message);
    }
    // Saved, but another press saved its own settlement over it a moment later? Then this one's entries go.
    if (moved) {
      const after = await Member.findById(m._id, { "settlement.slipNo": 1 }).lean();
      if (!after || !after.settlement || after.settlement.slipNo !== slipNo) {
        await Member.updateOne({ _id: m._id }, { $pull: { payments: { $in: made } } }).catch(() => {});
        moved = null;
      }
    }
    // Not moved out by this request (already moved out by another press, or an error): take its entries back.
    if (!moved) {
      await Payment.deleteMany({ _id: { $in: made } }).catch(() => {});
      const now = await Member.findById(m._id, { leftDate: 1 }).lean();
      return now && now.leftDate ? res.redirect(page(m._id)) : fail(res, url, "The move-out could not be saved. Please try again.");
    }
    if (m.assignedRoom_id) await syncRoomAndFloor(m.assignedRoom_id);
    const result = n.net > 0 ? `refund ${T.inr(n.net)} ${mode.toLowerCase()}` : n.net < 0 ? `${T.inr(-n.net)} to collect` : "nothing to pay either way";
    await T.logEvent(req, m, "movedOut", `Moved out of room ${m.assignedRoom || "—"} · bed ${m.bedLabel || "—"}`, `settlement ${slipNo}: ${result}`);

    // Slip on WhatsApp (only when its template is set up). Not waited for.
    const { slipOn, sendSettlementWhatsApp, buildSettlementPdf } = require("../utils/settlementPdf");
    if (slipOn()) {
      const fresh = await Member.findById(m._id).lean();
      slipFor(req, fresh).then(d => sendSettlementWhatsApp({ phone: fresh.mobileNo, tenantName: fresh.name, property: d.property, resultText: d.resultText, slipNo, pdf: buildSettlementPdf(d) })).catch(() => {});
    }
    back(res, page(m._id), `${m.name} moved out. Bed ${m.assignedRoom || ""}-${m.bedLabel || ""} is free. ${n.net > 0 ? `Refund ${T.inr(n.net)}.` : n.net < 0 ? `Collect ${T.inr(-n.net)}; it shows in Dues.` : ""}`.trim());
  } catch (err) {
    console.error("Move out error:", err.message);
    fail(res, url, "The move-out could not be saved. Please try again.");
  }
});

async function undoMoveOut(req, res) {
  try {
    const m = await actionable(req, res, { living: false });
    if (!m) return;
    const s = m.settlement;
    if (!m.leftDate || !s || !s.at || s.undoneAt || Date.now() - new Date(s.at) > 24 * 3600e3) return fail(res, page(m._id), "This move-out can no longer be undone.");
    // The bed must still be free.
    const room = m.assignedRoom_id ? await Room.findOne({ _id: m.assignedRoom_id, user: req.user.id }).lean() : null;
    if (!room) return fail(res, page(m._id), "Their room no longer exists, so the move-out cannot be undone.");
    const beds = await ensureBeds(room);
    const bed = beds.find(b => b.label === m.bedLabel);
    if (!bed || bed.member || bed.blocked) return fail(res, page(m._id), `Bed ${room.room_number}-${m.bedLabel} is no longer free, so the move-out cannot be undone.`);
    // Re-admitted as a new tenant in the meantime? Then undoing would make two living records for one person.
    const again = await Member.findOne({ _id: { $ne: m._id }, user: req.user.id, hostel: m.hostel, ...LIVING, mobileNo: m.mobileNo }, { name: 1, assignedRoom: 1 }).lean();
    if (again) return fail(res, page(m._id), `${again.name} with this mobile number is living here again (room ${again.assignedRoom || "—"}), so this move-out cannot be undone.`);
    const r = await Member.updateOne({ _id: m._id, user: req.user.id, leftDate: { $ne: null }, "settlement.undoneAt": null },
      { $set: { leftDate: null, status: "Active", "settlement.undoneAt": new Date() }, $pull: { payments: { $in: s.paymentIds || [] } } });
    if (!r.modifiedCount) return res.redirect(page(m._id));
    // Someone was admitted into that bed at the same moment? Then the undo is taken back.
    const sharing = await Member.countDocuments({ assignedRoom_id: room._id, bedLabel: m.bedLabel, ...LIVING });
    if (sharing > 1) {
      await Member.updateOne({ _id: m._id }, { $set: { leftDate: m.leftDate, status: "Inactive", "settlement.undoneAt": null }, $addToSet: { payments: { $each: s.paymentIds || [] } } });
      return fail(res, page(m._id), `Bed ${room.room_number}-${m.bedLabel} was just taken, so the move-out cannot be undone.`);
    }
    await Payment.deleteMany({ _id: { $in: s.paymentIds || [] }, memberId: m._id });
    await syncRoomAndFloor(room._id);
    await T.logEvent(req, m, "undoMoveOut", "Move-out undone, living here again", `settlement ${s.slipNo || ""} cancelled`);
    back(res, page(m._id), `Move-out undone. ${m.name} is living in ${room.room_number}-${m.bedLabel} again.`);
  } catch (err) {
    console.error("Undo move out error:", err.message);
    fail(res, page(req.params.id), "That could not be undone. Please try again.");
  }
}
router.post("/tenants/:id/undo-move-out", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    for (let i = 0; i < 20; i++) {
      const r = await require("../utils/locks").withLocks([await (async () => { const x = isId(String(req.params.id)) ? await Member.findOne({ _id: req.params.id, user: req.user.id }, { assignedRoom_id: 1 }).lean() : null; return x && x.assignedRoom_id ? `room:${x.assignedRoom_id}` : ""; })(), await (async () => { const x = isId(String(req.params.id)) ? await Member.findOne({ _id: req.params.id, user: req.user.id }, { hostel: 1, mobileNo: 1 }).lean() : null; return x ? `mobile:${x.hostel}:${x.mobileNo}` : ""; })()], () => undoMoveOut(req, res));
      if (!r.busy) return;
      await new Promise(z => setTimeout(z, 250));
    }
    fail(res, page(req.params.id), "Someone else is changing that room right now. Please try again.");
  } catch (err) {
    console.error("undoMoveOut (lock) error:", err.message);
    if (!res.headersSent) res.status(500).send("That could not be saved. Please try again.");
  }
});

// Everything printed on the slip.
async function slipFor(req, m) {
  const [hostel, owner] = await Promise.all([Hostel.findById(m.hostel).lean(), Owner.findById(req.user.id, { name: 1, phone: 1 }).lean()]);
  const s = m.settlement;
  const net = Number(s.net) || 0;
  return {
    slipNo: s.slipNo, date: T.dayYear(s.at), property: hostel?.hostelName || "", propertyPlace: [hostel?.city, hostel?.state].filter(Boolean).join(", "),
    ownerName: owner?.name || "", ownerPhone: owner?.phone || "", tenantName: m.name, tenantMobile: m.mobileNo,
    room: `${m.assignedRoom || "-"} - bed ${m.bedLabel || "-"}`, stay: `${T.dayYear(m.joiningDate)} - ${T.dayYear(m.leftDate)}`,
    depositHeld: s.depositHeld, advance: s.advance, dues: s.dues, deductions: s.deductions || [], net, mode: s.mode,
    resultText: net > 0 ? `Refund: ${T.inr(net)}` : net < 0 ? `To pay: ${T.inr(-net)}` : "Nothing to pay either way",
  };
}

router.get("/tenants/:id/slip.pdf", jwtAuthMiddleware, async (req, res) => {
  try {
    const m = await Member.findOne({ _id: isId(req.params.id) ? req.params.id : null, user: req.user.id }).lean();
    if (!m || !m.settlement || !m.settlement.at || m.settlement.undoneAt) return res.status(404).send("No settlement slip for this tenant.");
    const pdf = require("../utils/settlementPdf").buildSettlementPdf(await slipFor(req, m));
    res.set({ "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename="Settlement-${String(m.settlement.slipNo || "").replace(/[^A-Za-z0-9-]/g, "")}.pdf"` });
    res.send(pdf);
  } catch (err) {
    console.error("Settlement slip error:", err.message);
    res.status(500).send("The slip could not be made. Please try again.");
  }
});

router.post("/tenants/:id/slip/send", jwtAuthMiddleware, async (req, res) => {
  try {
    const m = await Member.findOne({ _id: isId(req.params.id) ? req.params.id : null, user: req.user.id }).lean();
    if (!m || !m.settlement || !m.settlement.at || m.settlement.undoneAt) return res.status(404).send("No settlement slip for this tenant.");
    const S = require("../utils/settlementPdf");
    if (!S.slipOn()) return fail(res, page(m._id), "Sending slips on WhatsApp is not set up yet. Download the PDF and share it.");
    const d = await slipFor(req, m);
    const r = await S.sendSettlementWhatsApp({ phone: m.mobileNo, tenantName: m.name, property: d.property, resultText: d.resultText, slipNo: d.slipNo, pdf: S.buildSettlementPdf(d) });
    r.sent ? back(res, page(m._id), "Settlement slip sent on WhatsApp.") : fail(res, page(m._id), "The slip could not be sent on WhatsApp. Download the PDF and share it.");
  } catch (err) {
    console.error("Settlement slip send error:", err.message);
    fail(res, page(req.params.id), "The slip could not be sent. Please try again.");
  }
});

/* ── documents (private) ── */
const DOC_DIR = "/secure_uploads/tenant-docs";
const DOC_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
const MAX_DOCS = 20;
function ensureDocDir() { try { if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true }); } catch (e) { console.error("Could not create tenant documents folder:", e.message); } }
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { ensureDocDir(); cb(null, DOC_DIR); },
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + DOC_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(DOC_TYPES, file.mimetype)),
});
// The browser's declared type isn't trusted: check the file's first bytes.
function looksLike(file) {
  try {
    const fd = fs.openSync(file.path, "r"); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
    switch (file.mimetype) {
      case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
      case "image/png": return b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "image/webp": return b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP";
      case "application/pdf": return b.slice(0, 4).toString() === "%PDF";
      default: return false;
    }
  } catch { return false; }
}
const dropFile = f => { if (f && f.path) fs.unlink(f.path, () => {}); };

router.post("/tenants/:id/documents", jwtAuthMiddleware, (req, res, next) => {
  docUpload.single("file")(req, res, err => {
    if (err) return fail(res, page(isId(req.params.id) ? req.params.id : "") + "?tab=documents", err.code === "LIMIT_FILE_SIZE" ? "That file is bigger than 5 MB." : "That file could not be uploaded.");
    next();
  });
}, async (req, res) => {
  const url = page(req.params.id) + "?tab=documents";
  try {
    const m = await myTenant(req, req.params.id);
    if (!m) { dropFile(req.file); return res.status(404).send("Tenant not found."); }
    if (!req.file) return fail(res, url, "Choose a PDF, JPG or PNG file (up to 5 MB).");
    if (!looksLike(req.file)) { dropFile(req.file); return fail(res, url, "That file is not a real PDF or image."); }
    if ((m.documents || []).length >= MAX_DOCS) { dropFile(req.file); return fail(res, url, `A tenant can have up to ${MAX_DOCS} documents. Delete one first.`); }
    const orig = path.basename(String(req.file.originalname || "")).replace(/\.[a-z0-9]{1,5}$/i, "");
    const name = clean(req.body.name || "", 60) || clean(orig, 60) || "Document";
    const r = await Member.updateOne({ _id: m._id, user: req.user.id }, { $push: { documents: { name, file: req.file.filename, mime: req.file.mimetype, size: req.file.size, uploadedAt: new Date() } } });
    if (!r.modifiedCount) { dropFile(req.file); return fail(res, url, `A tenant can have up to ${MAX_DOCS} documents. Delete one first.`); }
    await T.logEvent(req, m, "document", `Document added: ${name}`);
    back(res, url, `${name} uploaded. Only you can open it.`);
  } catch (err) {
    dropFile(req.file);
    console.error("Tenant document upload error:", err.message);
    fail(res, url, "The document could not be saved. Please try again.");
  }
});

router.get("/tenants/:id/documents/:docId", jwtAuthMiddleware, async (req, res) => {
  try {
    if (!isId(req.params.id) || !isId(req.params.docId)) return res.status(404).send("Document not found.");
    const m = await Member.findOne({ _id: req.params.id, user: req.user.id, ...NOT_REMOVED }, { documents: 1 }).lean();
    const d = m && (m.documents || []).find(x => String(x._id) === req.params.docId);
    const file = d && d.file ? path.join(DOC_DIR, path.basename(d.file)) : "";
    if (!file || !fs.existsSync(file)) return res.status(404).send("Document not found.");
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Type": d.mime || "application/octet-stream",
      "Content-Disposition": `inline; filename="${String(d.name || "document").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 60)}${DOC_TYPES[d.mime] || ""}"` });
    res.sendFile(file);
  } catch (err) {
    console.error("Tenant document open error:", err.message);
    res.status(500).send("Could not open the document.");
  }
});

router.post("/tenants/:id/documents/:docId/delete", jwtAuthMiddleware, async (req, res) => {
  const url = page(req.params.id) + "?tab=documents";
  try {
    if (!isId(req.params.docId)) return res.status(404).send("Document not found.");
    const m = await myTenant(req, req.params.id);
    const docs = (m && m.documents) || [];
    const at = docs.findIndex(x => String(x._id) === req.params.docId);
    if (at < 0) return res.status(404).send("Document not found.");
    const d = docs[at];
    // Write the list without this one, only if the list is still exactly as read (no upload or delete in between).
    const r = await Member.updateOne({ _id: m._id, user: req.user.id, documents: { $size: docs.length }, [`documents.${at}._id`]: d._id },
      { $set: { documents: docs.filter((_, i) => i !== at).map(x => (x.toObject ? x.toObject() : x)) } });
    if (!r.modifiedCount) return fail(res, url, "The documents changed a moment ago. Please try again.");
    if (d.file) await fs.promises.unlink(path.join(DOC_DIR, path.basename(d.file))).catch(() => {});
    await T.logEvent(req, m, "document", `Document deleted: ${d.name}`);
    back(res, url, `${d.name} deleted.`);
  } catch (err) {
    console.error("Tenant document delete error:", err.message);
    fail(res, url, "The document could not be deleted. Please try again.");
  }
});

module.exports = router;
