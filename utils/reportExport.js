/* ============================================================
   utils/reportExport.js  —  Property Operations Phase 9

   Reports → Download: the tab being viewed as
   • CSV that opens in Excel (UTF-8 with BOM, one table after another,
     amounts as plain numbers so Excel can add them up), or
   • PDF (A4, built-in Helvetica, no extra package — the same way as
     the receipts and statements).
   Both are made from the same tables (sections()), so they always match.
============================================================ */

const moment = require("moment-timezone");
const { TZ } = require("./tenantOps");
const T = require("./tenants");
const { clean, esc, widthOf, fit, rupees } = require("./settlementPdf")._pdf;

const TABS = { money: "Money", dues: "Dues", occupancy: "Occupancy", leads: "Leads and bookings", expenses: "Expenses and profit" };
const n = v => Math.round(Number(v) || 0);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + "%" : "-");
const ymd = d => (d ? moment(d).tz(TZ).format("YYYY-MM-DD") : "");

/** The tables of one tab: [{ title, cols: [{ label, w, money?, right? }], rows: [[…]], total?: […] }] */
function sections(r, tab) {
  const out = [];
  if (tab === "money") {
    out.push({ title: "Collected vs expected, last 12 months", cols: [{ label: "Month", w: 150 }, { label: "Expected", w: 110, money: true }, { label: "Collected", w: 110, money: true }, { label: "Collected %", w: 113, right: true }],
      rows: r.chart.map(c => [c.label, c.expected, c.collected, pct(c.collected, c.expected)]) });
    out.push({ title: `Collection by way of payment, ${r.label}`, cols: [{ label: "Way of payment", w: 260 }, { label: "Amount", w: 223, money: true }],
      rows: r.modes.map(x => [x.label, x.amount]), total: ["Total", r.money.collected] });
    out.push({ title: `By property, ${r.label}`, cols: [{ label: "Property", w: 160 }, { label: "Expected", w: 82, money: true }, { label: "Collected", w: 82, money: true }, { label: "Expenses", w: 77, money: true }, { label: "Profit", w: 82, money: true }],
      rows: r.byProperty.map(p => [p.name, p.expected, p.collected, p.expenses, p.profit]), total: ["All", r.money.expected, r.money.collected, r.expenses.total, r.profit] });
    if (r.occupancy) out.push({ title: "Move-ins and move-outs", cols: [{ label: "Month", w: 200 }, { label: "Moved in", w: 140, right: true }, { label: "Moved out", w: 143, right: true }],
      rows: r.occupancy.months.slice().reverse().map(m => [labelOf(m.key), m.ins, m.outs]) });
  } else if (tab === "dues") {
    out.push({ title: "Dues by age (today)", cols: [{ label: "Age", w: 200 }, { label: "Tenants", w: 120, right: true }, { label: "Amount", w: 163, money: true }],
      rows: r.dues.buckets.map(b => [b.label, b.tenants, b.amount]), total: ["Total", r.dues.rows.length, r.dues.total] });
    out.push({ title: "Who owes", cols: [{ label: "Tenant", w: 105 }, { label: "Property", w: 85 }, { label: "Room", w: 60 }, { label: "Owed since", w: 70 }, { label: "Days late", w: 45, right: true }, { label: "For", w: 63 }, { label: "Due", w: 55, money: true }],
      rows: r.dues.rows.map(x => [x.name, x.property, x.room, ymd(x.since), x.daysLate, x.dueFor, x.due]), total: ["Total", "", "", "", "", "", r.dues.total],
      extra: { cols: ["0-15 days", "16-30 days", "31-60 days", "Over 60 days"], rows: r.dues.rows.map(x => x.ages) } });
  } else if (tab === "occupancy") {
    const o = r.occupancy;
    out.push({ title: "Beds now", cols: [{ label: "Property", w: 163 }, { label: "Beds", w: 55, right: true }, { label: "Filled", w: 55, right: true }, { label: "Booked", w: 55, right: true }, { label: "Blocked", w: 55, right: true }, { label: "Free", w: 50, right: true }, { label: "Filled %", w: 50, right: true }],
      rows: o.now.map(x => [x.name, x.beds, x.filled, x.booked, x.blocked, x.free, x.pct + "%"]), total: ["All", o.total.beds, o.total.filled, o.total.booked, o.total.blocked, o.total.free, o.total.pct + "%"] });
    out.push({ title: "Tenants each month", cols: [{ label: "Month", w: 170 }, { label: "Tenants at month end", w: 125, right: true }, { label: "Moved in", w: 94, right: true }, { label: "Moved out", w: 94, right: true }],
      rows: o.months.slice().reverse().map(m => [labelOf(m.key), m.living, m.ins, m.outs]) });
  } else if (tab === "leads") {
    out.push({ title: "Leads and bookings to tenants", cols: [{ label: "Month", w: 100 }, { label: "Leads", w: 50, right: true }, { label: "Bookings paid (not cancelled)", w: 70, right: true }, { label: "Booking amount", w: 78, money: true }, { label: "Tenants from leads", w: 60, right: true }, { label: "From bookings", w: 55, right: true }, { label: "Walk-ins", w: 35, right: true }, { label: "Lead to tenant", w: 35, right: true }],
      rows: r.leads.slice().reverse().map(m => [labelOf(m.key), m.leads, m.bookings, m.bookingAmount, m.fromLeads, m.fromBookings, m.walkIns, m.rate === null ? "-" : m.rate + "%"]) });
  } else if (tab === "expenses") {
    out.push({ title: `Profit by property, ${r.label}`, cols: [{ label: "Property", w: 200 }, { label: "Income collected", w: 95, money: true }, { label: "Expenses", w: 94, money: true }, { label: "Profit", w: 94, money: true }],
      rows: r.byProperty.map(p => [p.name, p.collected, p.expenses, p.profit]), total: ["All", r.money.collected, r.expenses.total, r.profit] });
    out.push({ title: `Expenses, ${r.label}`, cols: [{ label: "Date", w: 70 }, { label: "Category", w: 95 }, { label: "Property", w: 100 }, { label: "Note", w: 148 }, { label: "Amount", w: 70, money: true }],
      rows: r.expenses.list.map(e => [ymd(e.date), e.cat.label, e.property, e.note || "", e.amount]), total: ["Total", "", "", "", r.expenses.total] });
    out.push({ title: "Profit, last 12 months", cols: [{ label: "Month", w: 170 }, { label: "Income collected", w: 105, money: true }, { label: "Expenses", w: 104, money: true }, { label: "Profit", w: 104, money: true }],
      rows: r.profitMonths.slice().reverse().map(m => [m.label, m.collected, m.expenses, m.profit]) });
  }
  return out;
}
const labelOf = key => moment.tz(key + "-01", "YYYY-MM-DD", TZ).format("MMMM YYYY");

/* ── CSV (Excel) ─────────────────────────────────────────── */
// A cell that starts like a formula (=, +, -, @) is written as text, so Excel never runs it.
function cell(v) {
  if (typeof v === "number") return String(Math.round(v));
  let s = String(v === null || v === undefined ? "" : v).replace(/[\r\n]+/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  return /[",;]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csv(r, tab, meta) {
  const lines = [];
  const row = a => lines.push(a.map(cell).join(","));
  row([`HostelNode report: ${TABS[tab]}`]);
  row([meta.property + (tab === "dues" || tab === "occupancy" ? " (as of " + meta.made + ")" : " - " + r.label)]);
  row([`Made ${meta.made}. Amounts in rupees.`]);
  for (const s of sections(r, tab)) {
    lines.push("");
    row([s.title]);
    row(s.cols.map(c => c.label).concat(s.extra ? s.extra.cols : []));
    s.rows.forEach((x, i) => row(x.concat(s.extra ? s.extra.rows[i] : [])));
    if (s.total) row(s.total);
  }
  return Buffer.from("﻿" + lines.join("\r\n") + "\r\n", "utf8");
}

/* ── PDF ─────────────────────────────────────────────────── */
const INK = [16, 35, 27], SOFT = [107, 124, 117], LINE = [226, 236, 231], CORAL = [200, 55, 45];
const L = 56, R = 539;
function pdf(r, tab, meta) {
  const pages = [];
  let ops = null, y = 0;
  const rgb = (a, b, c) => `${(a / 255).toFixed(3)} ${(b / 255).toFixed(3)} ${(c / 255).toFixed(3)}`;
  const text = (x, yy, str, { size = 9.5, bold = false, color = INK, right = false, max = R - L } = {}) => {
    const t = fit(clean(str), size, bold, max);
    if (!t) return;
    const px = right ? x - widthOf(t, size, bold) : x;
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(...color)} rg ${px.toFixed(2)} ${yy.toFixed(2)} Td (${esc(t)}) Tj ET`);
  };
  const line = (yy, color = LINE, w = 0.8) => ops.push(`${w} w ${rgb(...color)} RG ${L} ${yy.toFixed(2)} m ${R} ${yy.toFixed(2)} l S`);
  const box = (x, yy, w, h, color) => ops.push(`${rgb(...color)} rg ${x} ${yy} ${w} ${h} re f`);
  const page = first => {
    ops = []; pages.push(ops);
    if (first) {
      box(0, 752, 595, 90, INK);
      text(L, 800, "Report: " + TABS[tab], { size: 18, bold: true, color: [255, 255, 255], max: 330 });
      text(L, 782, meta.property, { size: 10, color: [205, 225, 214], max: 300 });
      text(R, 800, tab === "dues" || tab === "occupancy" ? "As of " + meta.made : r.label, { size: 12, bold: true, color: [255, 255, 255], right: true });
      text(R, 782, "Made " + meta.made, { size: 9, color: [205, 225, 214], right: true });
      y = 720;
    } else {
      text(L, 806, `${TABS[tab]} - ${meta.property} (continued)`, { size: 9.5, bold: true, color: SOFT });
      line(798);
      y = 778;
    }
  };
  const need = h => { if (y - h < 56) page(false); };
  page(true);
  const show = (c, v) => (c.money ? (Number(v) < 0 ? "-" : "") + rupees(v) : String(v === null || v === undefined ? "" : v));
  for (const s of sections(r, tab)) {
    need(60);
    text(L, y, s.title, { size: 11.5, bold: true }); y -= 18;
    const heads = () => {
      let x = L;
      for (const c of s.cols) { const right = c.money || c.right; text(right ? x + c.w - 4 : x, y, c.label, { size: 8.5, bold: true, color: SOFT, right, max: c.w - 6 }); x += c.w; }
      y -= 6; line(y, INK, 0.5); y -= 13;
    };
    heads();
    if (!s.rows.length) { text(L, y, "Nothing in this period.", { size: 9, color: SOFT }); y -= 16; }
    const rowOut = (vals, bold) => {
      if (y < 70) { page(false); heads(); }
      let x = L;
      s.cols.forEach((c, i) => {
        const right = c.money || c.right;
        const v = vals[i];
        text(right ? x + c.w - 4 : x, y, show(c, v), { size: 9, bold, right, max: c.w - 6, color: c.money && Number(v) < 0 ? CORAL : INK });
        x += c.w;
      });
      y -= 5; line(y); y -= 12;
    };
    s.rows.forEach(v => rowOut(v, false));
    if (s.total) rowOut(s.total, true);
    y -= 14;
  }
  need(20);
  text(L, y, "Made with HostelNode from your ledgers. Amounts in rupees.", { size: 8, color: SOFT });
  // Build the file.
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  const kids = [];
  for (const p of pages) {
    const stream = p.join("\n");
    objs.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const cid = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${cid} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
    kids.push(objs.length);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const at = [];
  objs.forEach((body, i) => { at.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map(v => String(v).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (${esc(clean("HostelNode report " + TABS[tab]))}) /Producer (HostelNode) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { TABS, sections, csv, pdf, cell };
