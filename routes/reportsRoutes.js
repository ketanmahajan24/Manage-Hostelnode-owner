/* ============================================================
   routes/reportsRoutes.js  —  Property Operations Phase 9
   Mounted at /user in app.js, before userRoutes.js (whose old Reports
   page it replaces; HN_REPORTS=off in .env shows the old page again).

     GET  /revenue                    Reports: Money, Dues, Occupancy, Leads & bookings, Expenses & profit
                                      ?tab=…&month=YYYY-MM&p=all|<property>&format=csv|pdf (download)
                                      (plan feature "Reports", as before)
     POST /expenses                   add an expense (with an optional bill photo or PDF)
     POST /expenses/:id               change an expense
     POST /expenses/:id/delete        delete an expense (kept, no longer counted)
     GET  /expenses/:id/bill          open the bill (only this owner)
     GET  /dues/reminders             automatic rent reminder settings
     POST /dues/reminders             save them
     POST /tenants/:id/remind         "Send reminder" now (WhatsApp / email from HostelNode)

   Every query is limited to the logged-in owner's own properties and tenants.
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
const Member = require("../models/member");
const Expense = require("../models/expense");
const { TZ, NOT_REMOVED, isId } = require("../utils/tenantOps");
const T = require("../utils/tenants");
const L = require("../utils/ledger");
const P = require("../utils/payments");
const R = require("../utils/reports");
const X = require("../utils/reportExport");
const RR = require("../utils/rentReminders");

const clean = P.clean;
const on = (req, res, next) => (/^(off|0|false|no)$/i.test(String(process.env.HN_REPORTS || "").trim()) ? next("router") : next());
const TABS = ["money", "dues", "occupancy", "leads", "expenses"];
const curKey = () => moment().tz(TZ).format("YYYY-MM");
const withParam = (url, k, v) => `${url}${url.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;
const flash = req => ({ msg: clean(req.query.msg || "", 240), err: clean(req.query.err || "", 240) });

function moneyIn(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}
function dateIn(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const m = moment.tz(s, "YYYY-MM-DD", true, TZ);
  return m.isValid() ? m : null;
}

/** The properties a report covers: ?p=all (every property) or one of the owner's. */
function scopeOf(req, hostels) {
  const p = String(req.query.p || "");
  if (hostels.length === 1) return { p: String(hostels[0]._id), list: hostels, all: true, name: hostels[0].hostelName };
  const h = p && p !== "all" ? hostels.find(x => String(x._id) === p) : null;
  if (h) return { p: String(h._id), list: [h], all: false, name: h.hostelName };
  return { p: "all", list: hostels, all: true, name: "All properties" };   // (the default)
}
const reportUrl = (o) => { const q = Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== null).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&"); return "/user/revenue" + (q ? "?" + q : ""); };
// Where to go back to after an action: only the Reports page.
function backTo(req) {
  const raw = String((req.body || {}).back || "");
  if (!/^\/user\/revenue(\?[A-Za-z0-9=&%._+-]*)?$/.test(raw)) return "/user/revenue?tab=expenses";
  return raw.replace(/([?&])(msg|err|add|edit|v_[a-z]+)=[^&]*/g, "$1").replace(/[?&]+$/, "").replace(/\?&+/, "?").replace(/&&+/g, "&");
}

/* ── Reports ─────────────────────────────────────────────── */
router.get("/revenue", jwtAuthMiddleware, on, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    const hostels = (res.locals.hostels || []).filter(h => String(h.owner) === String(req.user.id));
    const tab = TABS.includes(req.query.tab) ? req.query.tab : "money";
    const cur = curKey();
    const key = R.isKey(req.query.month) && req.query.month <= cur ? String(req.query.month) : cur;
    if (!hostels.length) {
      res.set("Cache-Control", "no-store");
      return res.render("reports/index.ejs", { user, none: true, tab, key, cur, T, flash: flash(req) });
    }
    const scope = scopeOf(req, hostels);
    const r = await R.build({ ownerId: req.user.id, hostels: scope.list, all: scope.all, key, tab: req.query.format ? tab : "all" });
    const made = T.dayYear(new Date());
    const fmt = String(req.query.format || "");
    if (fmt === "csv" || fmt === "pdf") {
      const meta = { property: scope.name, made };
      const base = `HostelNode-${({ money: "Money", dues: "Dues", occupancy: "Occupancy", leads: "Leads", expenses: "Expenses-Profit" })[tab]}-${tab === "dues" || tab === "occupancy" ? moment().tz(TZ).format("YYYY-MM-DD") : key}`;
      res.set("Cache-Control", "private, no-store");
      if (fmt === "csv") {
        res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.csv"` });
        return res.send(X.csv(r, tab, meta));
      }
      res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${base}.pdf"` });
      return res.send(X.pdf(r, tab, meta));
    }
    // Reminder status for the Dues tab.
    const last = await RR.lastReminders(r.dues.rows.map(x => x.id));
    const canSend = await RR.sendable(req.user.id, r.dues.rows);
    // The expense being changed (drawer), or a new one.
    let drawer = null;
    if (tab === "expenses" && (req.query.add === "1" || isId(String(req.query.edit || "")))) {
      const e = req.query.edit ? await Expense.findOne({ _id: req.query.edit, owner: req.user.id, deletedAt: null }).lean() : null;
      if (req.query.edit && !e) drawer = null;
      else {
        const v = k => clean(req.query["v_" + k] || "", 120);
        const selected = res.locals.selectedHostel && hostels.some(h => String(h._id) === String(res.locals.selectedHostel._id)) ? String(res.locals.selectedHostel._id) : String(hostels[0]._id);
        drawer = {
          id: e ? String(e._id) : "",
          category: v("cat") || (e && e.category) || "electricity",
          amount: v("amount") || (e ? String(e.amount) : ""),
          date: v("date") || (e ? T.ymd(e.date) : T.ymd(new Date())),
          hostel: v("h") || (e ? String(e.hostel) : scope.all ? selected : scope.p),
          note: v("note") || (e && e.note) || "",
          bill: e && e.bill && e.bill.file ? { name: e.bill.name || "Bill" } : null,
        };
      }
    }
    res.set("Cache-Control", "no-store");
    res.render("reports/index.ejs", {
      user, none: false, tab, key, cur, r, scope, hostels, T, R, RR, flash: flash(req), drawer, made,
      last: Object.fromEntries([...last].map(([k, v]) => [k, RR.lastText(v)])),
      months: R.monthKeys(cur, 24).reverse().map(k => ({ key: k, label: L.monthLabel(k) })),
      reportUrl, self: req.originalUrl.replace(/([?&])(msg|err|add|edit|v_[a-z]+)=[^&]*/g, "$1").replace(/[?&]+$/, "").replace(/\?&+/, "?").replace(/&&+/g, "&"),
      reminders: RR.channels(), canSend: [...canSend],
    });
  } catch (err) {
    console.error("Reports page error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/* ── Expenses ────────────────────────────────────────────── */
const BILL_DIR = "/secure_uploads/expense-bills";
const BILL_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
function ensureBillDir() { try { if (!fs.existsSync(BILL_DIR)) fs.mkdirSync(BILL_DIR, { recursive: true }); } catch (e) { console.error("Could not create expense bills folder:", e.message); } }
const billUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { ensureBillDir(); cb(null, BILL_DIR); },
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + BILL_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (Object.prototype.hasOwnProperty.call(BILL_TYPES, file.mimetype)) return cb(null, true);
    const e = new Error("bill type"); e.code = "BILL_TYPE"; cb(e);
  },
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
const withBill = (req, res, next) => billUpload.single("bill")(req, res, err => {
  if (err) {
    if (req.file) dropFile(req.file);
    return failExpense(req, res, err.code === "LIMIT_FILE_SIZE" ? "The bill is bigger than 5 MB." : "The bill could not be uploaded. Choose a photo (JPG, PNG) or a PDF.", req.params.id);
  }
  next();
});

/** Check the form; returns { ok, err, value } */
async function expenseFrom(req) {
  const category = Object.prototype.hasOwnProperty.call(R.EXPENSE_CATS, req.body.category) ? req.body.category : "";
  const amount = moneyIn(req.body.amount);
  const date = dateIn(req.body.date);
  const note = clean(req.body.note || "", 120);
  const hostelId = String(req.body.hostel || "");
  const today = moment().tz(TZ).startOf("day");
  if (!category) return { err: "Choose what the expense is for." };
  if (amount === null || amount <= 0) return { err: "Enter the amount spent." };
  if (!date) return { err: "Enter the date it was spent." };
  if (date.isAfter(today)) return { err: "The date cannot be in the future." };
  if (date.isBefore(moment.tz("2000-01-01", TZ))) return { err: "Check the date." };
  if (category === "other" && !note) return { err: "Say what the expense is for (note)." };
  const h = isId(hostelId) ? await Hostel.findOne({ _id: hostelId, owner: req.user.id }, { _id: 1 }).lean() : null;
  if (!h) return { err: "Choose the property." };
  return { value: { category, amount, date: date.toDate(), month: date.format("YYYY-MM"), note, hostel: h._id } };
}
function failExpense(req, res, err, id) {
  dropFile(req.file);
  let u = withParam(backTo(req), id ? "edit" : "add", id || "1");
  const b = req.body || {};
  const keep = { cat: b.category, amount: b.amount, date: b.date, h: b.hostel, note: b.note };
  for (const [k, v] of Object.entries(keep)) if (v) u = withParam(u, "v_" + k, clean(String(v), 120));
  res.redirect(withParam(u, "err", err));
}
const billOf = f => ({ file: f.filename, mime: f.mimetype, size: f.size, name: clean(path.basename(String(f.originalname || "")), 80) || "Bill" });

router.post("/expenses", jwtAuthMiddleware, withBill, async (req, res) => {
  try {
    const f = await expenseFrom(req);
    if (f.err) return failExpense(req, res, f.err);
    if (req.file && !looksLike(req.file)) return failExpense(req, res, "That file is not a real photo or PDF.");
    // The same expense sent again within 15 seconds (double tap) is saved once.
    const dup = await Expense.findOne({ owner: req.user.id, hostel: f.value.hostel, category: f.value.category, amount: f.value.amount, date: f.value.date, deletedAt: null,
      _id: { $gt: require("mongoose").Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 15) } }).lean();
    if (dup) { dropFile(req.file); return res.redirect(withParam(backTo(req), "msg", "That expense was already saved.")); }
    const owner = await Owner.findById(req.user.id, { name: 1 }).lean();
    await Expense.create(Object.assign({}, f.value, { owner: req.user.id, createdBy: { id: req.user.id, name: (owner && owner.name) || "" } }, req.file ? { bill: billOf(req.file) } : {}));
    const label = R.EXPENSE_CATS[f.value.category].label;
    let back = backTo(req);
    // Show the month it was added to.
    back = back.replace(/([?&])month=[^&]*/, "$1").replace(/[?&]+$/, "").replace(/\?&+/, "?").replace(/&&+/g, "&");
    if (f.value.month !== curKey()) back = withParam(back, "month", f.value.month);
    res.redirect(withParam(back, "msg", `${label} ${T.inr(f.value.amount)} saved.`));
  } catch (err) {
    console.error("Add expense error:", err.message);
    failExpense(req, res, "The expense could not be saved. Please try again.");
  }
});

router.post("/expenses/:id", jwtAuthMiddleware, withBill, async (req, res) => {
  const id = String(req.params.id);
  try {
    if (!isId(id)) { dropFile(req.file); return res.status(404).send("Expense not found."); }
    const e = await Expense.findOne({ _id: id, owner: req.user.id, deletedAt: null }).lean();
    if (!e) { dropFile(req.file); return res.status(404).send("Expense not found."); }
    const f = await expenseFrom(req);
    if (f.err) return failExpense(req, res, f.err, id);
    if (req.file && !looksLike(req.file)) return failExpense(req, res, "That file is not a real photo or PDF.", id);
    const set = Object.assign({}, f.value);
    const unset = {};
    let oldFile = "";
    if (req.file) { set.bill = billOf(req.file); oldFile = e.bill && e.bill.file; }
    else if (req.body.removeBill === "1" && e.bill && e.bill.file) { unset.bill = 1; oldFile = e.bill.file; }
    const r = await Expense.updateOne({ _id: e._id, owner: req.user.id, deletedAt: null }, Object.assign({ $set: set }, Object.keys(unset).length ? { $unset: unset } : {}));
    if (!r.matchedCount) { dropFile(req.file); return res.status(404).send("Expense not found."); }
    if (oldFile) await fs.promises.unlink(path.join(BILL_DIR, path.basename(oldFile))).catch(() => {});
    res.redirect(withParam(backTo(req), "msg", `${R.EXPENSE_CATS[f.value.category].label} ${T.inr(f.value.amount)} updated.`));
  } catch (err) {
    console.error("Change expense error:", err.message);
    failExpense(req, res, "The expense could not be saved. Please try again.", id);
  }
});

router.post("/expenses/:id/delete", jwtAuthMiddleware, async (req, res) => {
  try {
    if (!isId(String(req.params.id))) return res.status(404).send("Expense not found.");
    const e = await Expense.findOneAndUpdate({ _id: req.params.id, owner: req.user.id, deletedAt: null }, { $set: { deletedAt: new Date() } }).lean();
    if (!e) return res.redirect(withParam(backTo(req), "err", "That expense was already deleted."));
    res.redirect(withParam(backTo(req), "msg", `${(R.EXPENSE_CATS[e.category] || R.EXPENSE_CATS.other).label} ${T.inr(e.amount)} deleted.`));
  } catch (err) {
    console.error("Delete expense error:", err.message);
    res.status(500).send("That could not be done. Please try again.");
  }
});

router.get("/expenses/:id/bill", jwtAuthMiddleware, async (req, res) => {
  try {
    if (!isId(String(req.params.id))) return res.status(404).send("Bill not found.");
    const e = await Expense.findOne({ _id: req.params.id, owner: req.user.id }, { bill: 1 }).lean();
    const file = e && e.bill && e.bill.file ? path.join(BILL_DIR, path.basename(e.bill.file)) : "";
    if (!file || !fs.existsSync(file)) return res.status(404).send("Bill not found.");
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Type": BILL_TYPES[e.bill.mime] ? e.bill.mime : "application/octet-stream",
      "Content-Disposition": `inline; filename="${String(e.bill.name || "bill").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 60) || "bill"}${BILL_TYPES[e.bill.mime] || ""}"` });
    res.sendFile(file);
  } catch (err) {
    console.error("Expense bill open error:", err.message);
    res.status(500).send("Could not open the bill.");
  }
});

/* ── Rent reminders ──────────────────────────────────────── */
router.get("/dues/reminders", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    const hostels = (res.locals.hostels || []).filter(h => String(h.owner) === String(req.user.id));
    const s = await RR.settingsOf(req.user.id);
    const tenants = hostels.length ? await Member.find({ user: req.user.id, hostel: { $in: hostels.map(h => h._id) }, leftDate: null, ...NOT_REMOVED }, { email: 1, mobileNo: 1 }).lean() : [];
    res.set("Cache-Control", "no-store");
    res.render("reports/reminders.ejs", { user, s, hostels, T, RR, channels: RR.channels(), flash: flash(req),
      counts: { tenants: tenants.length, email: tenants.filter(t => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(t.email || "").trim())).length } });
  } catch (err) {
    console.error("Reminder settings error:", err.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

router.post("/dues/reminders", jwtAuthMiddleware, async (req, res) => {
  try {
    const hostels = await Hostel.find({ owner: req.user.id }, { _id: 1 }).lean();
    const s = await RR.saveSettings(req.user.id, req.body, hostels);
    res.redirect("/user/dues/reminders?msg=" + encodeURIComponent(s.on ? "Reminder settings saved." : "Automatic reminders are off. You can still send one from Dues."));
  } catch (err) {
    console.error("Save reminder settings error:", err.message);
    res.redirect("/user/dues/reminders?err=" + encodeURIComponent("The settings could not be saved. Please try again."));
  }
});

router.post("/tenants/:id/remind", jwtAuthMiddleware, async (req, res) => {
  const raw = String(req.body.back || "");
  const back = /^\/user\/(dues|revenue)(\?[A-Za-z0-9=&%._+-]*)?$/.test(raw) ? raw.replace(/([?&])(msg|err|paid)=[^&]*/g, "$1").replace(/[?&]+$/, "").replace(/\?&+/, "?").replace(/&&+/g, "&") : "/user/dues";
  try {
    if (!isId(String(req.params.id))) return res.status(404).send("Tenant not found.");
    const m = await Member.findOne({ _id: req.params.id, user: req.user.id, ...NOT_REMOVED }).populate("payments");
    if (!m) return res.status(404).send("Tenant not found.");
    const owner = await Owner.findById(req.user.id, { name: 1 }).lean();
    const r = await RR.sendNow({ ownerId: req.user.id, ownerName: (owner && owner.name) || "", m });
    res.redirect(withParam(back, r.ok ? "msg" : "err", r.text));
  } catch (err) {
    console.error("Send reminder error:", err.message);
    res.redirect(withParam(back, "err", "The reminder could not be sent. Please try again."));
  }
});

module.exports = router;
