/* ============================================================
   utils/ledgerPdf.js  —  Property Operations Phase 5

   • Rent receipt PDF (one page) and the tenant's statement PDF (as
     many pages as needed), made the same way as the settlement slip:
     no extra package, built-in Helvetica, amounts as "Rs. 6,500".
   • Sends the receipt on WhatsApp from HostelNode's number, only when
     an approved template is set in WA_TEMPLATE_RENT_RECEIPT (off
     otherwise). Template (category Utility, language en):
       Header  Document
       Body    Hi {{1}}, {{2}} received {{3}} ({{4}}) on {{5}}.
               For: {{6}}.
               Receipt no. {{7}} is attached.
============================================================ */

const { clean, esc, widthOf, fit, rupees } = require("./settlementPdf")._pdf;

const INK = [16, 35, 27], SOFT = [107, 124, 117], GREEN = [10, 125, 76], CORAL = [200, 55, 45], LINE = [226, 236, 231], AMBER = [180, 83, 9];
const L = 56, R = 539, TOP = 842;

/** A tiny page writer: text, lines, boxes; new pages as needed. */
function doc(title) {
  const pages = [];
  let ops = null;
  const rgb = (a, b, c) => `${(a / 255).toFixed(3)} ${(b / 255).toFixed(3)} ${(c / 255).toFixed(3)}`;
  const api = {
    page() { ops = []; pages.push(ops); return api; },
    text(x, y, str, { size = 10, bold = false, color = INK, right = false, max = R - L, strike = false } = {}) {
      const t = fit(clean(str), size, bold, max);
      if (!t) return;
      const w = widthOf(t, size, bold);
      const px = right ? x - w : x;
      ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(...color)} rg ${px.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
      if (strike) api.line(px, y + size * 0.32, px + w, y + size * 0.32, color, 0.7);
    },
    line(x1, y1, x2, y2, color = LINE, w = 1) { ops.push(`${w} w ${rgb(...color)} RG ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); },
    box(x, y, w, h, color) { ops.push(`${rgb(...color)} rg ${x} ${y} ${w} ${h} re f`); },
    build() {
      const objs = ["<< /Type /Catalog /Pages 2 0 R >>", null];
      const fontsAt = 3;
      objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      const kids = [];
      for (const p of pages) {
        const stream = p.join("\n");
        objs.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
        const contentId = objs.length;
        objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontsAt} 0 R /F2 ${fontsAt + 1} 0 R >> >> >>`);
        kids.push(objs.length);
      }
      objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
      let out = "%PDF-1.4\n";
      const at = [];
      objs.forEach((body, i) => { at.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
      const xref = Buffer.byteLength(out, "latin1");
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map(n => String(n).padStart(10, "0") + " 00000 n \n").join("");
      out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (${esc(clean(title))}) /Producer (HostelNode) >> >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(out, "latin1");
    },
  };
  return api;
}

function header(d, { property, place, phone, title, sub }) {
  d.box(0, 742, 595, 100, INK);
  d.text(L, 796, property || "Receipt", { size: 20, bold: true, color: [255, 255, 255], max: 300 });
  d.text(L, 778, [place, phone].filter(Boolean).join("  -  "), { size: 10, color: [205, 225, 214], max: 300 });
  d.text(R, 796, title, { size: 16, bold: true, color: [255, 255, 255], right: true });
  d.text(R, 778, sub || "", { size: 10, color: [205, 225, 214], right: true });
}

/**
 * r: { receiptNo, date, property, propertyPlace, ownerName, ownerPhone, tenantName, tenantMobile, room,
 *      amount, mode, reference, note, applied:[{label, amount}], dueAfter, recordedBy, cancelled: {at, reason} | null }
 */
function buildReceiptPdf(r) {
  const d = doc("Rent receipt " + (r.receiptNo || "")).page();
  header(d, { property: r.property, place: r.propertyPlace, phone: r.ownerPhone, title: "RENT RECEIPT", sub: "No. " + (r.receiptNo || "-") });
  let y = 700;
  d.text(L, y, "Received from", { size: 10, color: SOFT });
  d.text(L + 80, y, [r.tenantName, r.room ? "(" + r.room + ")" : ""].filter(Boolean).join(" "), { size: 12, bold: true, max: 400 });
  y -= 44;
  d.text(L, y, rupees(r.amount), { size: 30, bold: true, color: r.cancelled ? SOFT : GREEN, strike: !!r.cancelled });
  if (r.cancelled) d.text(R, y + 8, "CANCELLED", { size: 14, bold: true, color: CORAL, right: true });
  y -= 30;
  const kv = (k, v, color) => { d.text(L, y, k, { size: 10, color: SOFT }); d.text(R, y, v, { size: 10.5, bold: true, right: true, max: 360, color: color || INK }); y -= 8; d.line(L, y, R, y); y -= 16; };
  kv("Date", r.date || "-");
  kv("Paid by", [r.mode, r.reference ? "ref " + r.reference : ""].filter(Boolean).join("  -  ") || "-");
  const applied = (r.applied || []).filter(a => a && a.amount > 0);
  if (applied.length) {
    const shown = applied.length > 10 ? applied.slice(0, 9) : applied;
    shown.forEach((a, i) => kv(i === 0 ? "For" : "", `${a.label}  ${rupees(a.amount)}`));
    if (shown.length < applied.length) { const rest = applied.slice(shown.length); kv("", `and ${rest.length} more  ${rupees(rest.reduce((s, a) => s + a.amount, 0))}`); }
  }
  if (typeof r.dueAfter === "number") kv("Still due after this", rupees(r.dueAfter), r.dueAfter > 0 ? CORAL : INK);
  if (r.note) kv("Note", r.note);
  kv("Recorded by", r.recordedBy || "-");
  if (r.cancelled) { kv("Cancelled", [r.cancelled.at, r.cancelled.reason].filter(Boolean).join("  -  "), CORAL); }
  y -= 20;
  d.text(L, y, `Made with HostelNode for ${r.property || "the property"}${r.ownerName ? " (" + r.ownerName + ")" : ""}. This is a computer-made receipt.`, { size: 8.5, color: SOFT });
  return d.build();
}

/**
 * s: { property, propertyPlace, ownerPhone, tenantName, tenantMobile, room, stay, made, rentLine,
 *      charged, paid, due, advance, deposit: { agreed, held, text },
 *      months: [{ label, charged, paid, balance, status, lines: [{ text, amount, strike, soft }] }] }
 */
function buildStatementPdf(s) {
  const d = doc("Statement " + (s.tenantName || ""));
  let y;
  const newPage = first => {
    d.page();
    if (first) {
      header(d, { property: s.property, place: s.propertyPlace, phone: s.ownerPhone, title: "RENT STATEMENT", sub: s.made || "" });
      y = 712;
    } else {
      d.text(L, 806, `${s.tenantName || ""}  -  rent statement (continued)`, { size: 10, bold: true, color: SOFT });
      d.line(L, 798, R, 798);
      y = 776;
    }
  };
  newPage(true);
  const need = h => { if (y - h < 60) newPage(false); };
  const kv = (k, v) => { d.text(L, y, k, { size: 10, color: SOFT }); d.text(R, y, v, { size: 10.5, bold: true, right: true, max: 360 }); y -= 18; };
  kv("Tenant", [s.tenantName, s.tenantMobile].filter(Boolean).join("  -  "));
  kv("Room", s.room || "-");
  kv("Stay", s.stay || "-");
  if (s.rentLine) kv("Rent", s.rentLine);
  if (s.deposit && s.deposit.text) kv("Security deposit", s.deposit.text);
  y -= 6;
  d.box(L, y - 34, R - L, 44, [242, 250, 246]);
  const cols = [["Charged", s.charged, INK], ["Paid", s.paid, GREEN], [s.advance > 0 ? "In advance" : "Due now", s.advance > 0 ? s.advance : s.due, s.due > 0 ? CORAL : INK]];
  cols.forEach((c, i) => { const x = L + 14 + i * 160; d.text(x, y - 6, c[0], { size: 9, bold: true, color: SOFT }); d.text(x, y - 24, rupees(c[1]), { size: 14, bold: true, color: c[2] }); });
  y -= 60;
  // Column heads
  const C1 = L, C2 = 270, C3 = 345, C4 = 420;
  const heads = () => { d.text(C1, y, "Month", { size: 9, bold: true, color: SOFT }); d.text(C2, y, "Charged", { size: 9, bold: true, color: SOFT, right: true }); d.text(C3, y, "Paid", { size: 9, bold: true, color: SOFT, right: true }); d.text(C4, y, "Balance", { size: 9, bold: true, color: SOFT, right: true }); d.text(R, y, "Status", { size: 9, bold: true, color: SOFT, right: true }); y -= 8; d.line(L, y, R, y, INK, 0.6); y -= 16; };
  heads();
  for (const mo of s.months || []) {
    need(22 + (mo.lines || []).length * 14);
    if (y > 760) heads();
    const tone = mo.balance > 0 ? CORAL : GREEN;
    d.text(C1, y, mo.label, { size: 11, bold: true });
    d.text(C2, y, rupees(mo.charged), { size: 10.5, right: true });
    d.text(C3, y, rupees(mo.paid), { size: 10.5, right: true, color: GREEN });
    d.text(C4, y, rupees(mo.balance), { size: 10.5, bold: true, right: true, color: mo.balance > 0 ? CORAL : INK });
    d.text(R, y, mo.status || "", { size: 9.5, bold: true, right: true, color: mo.balance > 0 ? (tone === CORAL ? CORAL : AMBER) : GREEN, max: 112 });
    y -= 15;
    for (const ln of mo.lines || []) {
      need(14);
      d.text(C1 + 12, y, ln.text, { size: 9, color: ln.soft || ln.strike ? SOFT : [61, 79, 71], max: ln.amount === undefined || ln.amount === null ? R - C1 - 12 : C4 - C1 - 70, strike: !!ln.strike });
      if (ln.amount !== undefined && ln.amount !== null) d.text(C4, y, rupees(ln.amount), { size: 9, right: true, color: ln.strike ? SOFT : [61, 79, 71], strike: !!ln.strike });
      y -= 13;
    }
    y -= 4; d.line(L, y + 6, R, y + 6); y -= 8;
  }
  need(30);
  y -= 10;
  d.text(L, y, `Made with HostelNode on ${s.made || ""}. Payments are applied to the oldest unpaid month first.`, { size: 8.5, color: SOFT });
  return d.build();
}

const receiptTemplate = () => String(process.env.WA_TEMPLATE_RENT_RECEIPT || "").trim();
const receiptLang = () => String(process.env.WA_TEMPLATE_RENT_RECEIPT_LANG || "en").trim();
const receiptOn = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID && !!receiptTemplate() && !/^(off|0|false)$/i.test(receiptTemplate());

/** Send the receipt PDF on WhatsApp. Returns { sent, why }. Never throws. */
async function sendReceiptWhatsApp({ phone, tenantName, property, amount, mode, date, forText, receiptNo, pdf }) {
  try {
    if (!receiptOn()) return { sent: false, why: "off" };
    const { mobileOf, live } = require("./planReceiptWhatsapp");
    const mobile = mobileOf(phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 200) || "-";
    const filename = "Receipt-" + String(receiptNo || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) + ".pdf";
    const mediaId = await live.uploadPdf(pdf, filename);
    const first = String(tenantName || "").trim().split(/\s+/)[0] || "there";
    await live.sendTemplate("91" + mobile, receiptTemplate(), receiptLang(), [first, property, amount, mode, date, forText, receiptNo].map(tidy), mediaId, filename);
    return { sent: true };
  } catch (err) {
    console.error("Rent receipt WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

module.exports = { buildReceiptPdf, buildStatementPdf, sendReceiptWhatsApp, receiptOn };
