/* ============================================================
   utils/settlementPdf.js  —  Property Operations Phase 3

   The move-out settlement slip as a one-page A4 PDF (a Buffer), built
   the same way as the plan receipt (utils/receiptPdf.js): no extra
   package, the PDF's built-in Helvetica font, amounts as "Rs. 5,750".

   Also sends the slip on WhatsApp, only when an approved template is
   set in WA_TEMPLATE_SETTLEMENT_SLIP (off otherwise). Template:
     Header  Document
     Body    Hi {{1}}, your stay at {{2}} is settled. {{3}}.
             Settlement slip no. {{4}} is attached.
============================================================ */

const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const WB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const clean = v => String(v === null || v === undefined ? "" : v)
  .replace(/₹\s?/g, "Rs. ").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, "-")
  .replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7E]/g, "?").trim();
const esc = s => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const widthOf = (s, size, bold) => { let w = 0; for (const ch of s) w += (bold ? WB : W)[ch.charCodeAt(0) - 32] || 556; return (w * size) / 1000; };
const fit = (s, size, bold, max) => { let t = s; while (t.length > 1 && widthOf(t, size, bold) > max) t = t.slice(0, -1); return t === s ? s : t.slice(0, -2) + ".."; };
const rupees = n => "Rs. " + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.abs(Number(n) || 0));

/**
 * s: { slipNo, date, property, propertyPlace, ownerName, ownerPhone, tenantName, tenantMobile,
 *      stay, room, depositHeld, advance, dues, deductions:[{label,amount}], net, mode }
 */
function buildSettlementPdf(s) {
  const ops = [];
  const L = 56, R = 539;
  const rgb = (a, b, c) => `${(a / 255).toFixed(3)} ${(b / 255).toFixed(3)} ${(c / 255).toFixed(3)}`;
  const text = (x, y, str, { size = 10, bold = false, color = [16, 35, 27], right = false, max = R - L } = {}) => {
    const t = fit(clean(str), size, bold, max);
    if (!t) return;
    const px = right ? x - widthOf(t, size, bold) : x;
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(...color)} rg ${px.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, color = [226, 236, 231], w = 1) => ops.push(`${w} w ${rgb(...color)} RG ${x1} ${y1} m ${x2} ${y2} l S`);
  const box = (x, y, w, h, color) => ops.push(`${rgb(...color)} rg ${x} ${y} ${w} ${h} re f`);
  const SOFT = [107, 124, 117], GREEN = [10, 125, 76], CORAL = [200, 55, 45], BODY = [61, 79, 71];

  box(0, 742, 595, 100, [16, 35, 27]);
  text(L, 796, s.property || "Settlement", { size: 20, bold: true, color: [255, 255, 255], max: 300 });
  text(L, 778, s.propertyPlace || "", { size: 10, color: [205, 225, 214], max: 300 });
  text(R, 796, "SETTLEMENT SLIP", { size: 16, bold: true, color: [255, 255, 255], right: true });
  text(R, 778, "No. " + (s.slipNo || "-") + "   " + (s.date || ""), { size: 10, color: [205, 225, 214], right: true });

  let y = 704;
  const kv = (k, v) => { text(L, y, k, { size: 10, color: SOFT }); text(R, y, v, { size: 10.5, bold: true, right: true, max: 330 }); y -= 20; };
  kv("Tenant", [s.tenantName, s.tenantMobile].filter(Boolean).join("  -  "));
  kv("Room", s.room || "-");
  kv("Stay", s.stay || "-");
  y -= 8; line(L, y, R, y); y -= 26;

  box(L, y - 8, R - L, 26, [242, 250, 246]);
  text(L + 12, y, "Deposit settlement", { size: 9, bold: true, color: SOFT });
  text(R - 12, y, "Amount", { size: 9, bold: true, color: SOFT, right: true });
  y -= 30;
  const row = (label, amount, sign) => {
    text(L + 12, y, label, { size: 11, max: 340 });
    text(R - 12, y, (sign || "") + rupees(amount), { size: 11, right: true, color: sign === "- " ? CORAL : [16, 35, 27] });
    y -= 22;
  };
  row("Security deposit held", s.depositHeld);
  if (Number(s.advance) > 0) row("Rent paid in advance", s.advance);
  if (Number(s.dues) > 0) row("Unpaid rent and dues", s.dues, "- ");
  for (const d of s.deductions || []) row(d.label, d.amount, "- ");
  y += 6; line(L, y, R, y); y -= 26;
  const refund = Number(s.net) >= 0;
  text(L + 12, y, refund ? `Refunded to tenant${s.mode ? " (" + s.mode + ")" : ""}` : "Paid by tenant", { size: 13, bold: true });
  text(R - 12, y, rupees(s.net), { size: 15, bold: true, color: refund ? GREEN : CORAL, right: true });

  y -= 70;
  line(L, y, 250, y, BODY); line(345, y, R, y, BODY);
  y -= 14;
  text(L, y, "Tenant's signature", { size: 9, color: SOFT });
  text(345, y, "For " + (s.property || "the property"), { size: 9, color: SOFT, max: 190 });
  y -= 40;
  text(L, y, `Prepared by ${s.ownerName || "the owner"}${s.ownerPhone ? " (" + s.ownerPhone + ")" : ""} with HostelNode on ${s.date || ""}.`, { size: 8.5, color: SOFT });

  const stream = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const at = [];
  objs.forEach((body, i) => { at.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map(n => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (Settlement slip ${esc(clean(s.slipNo || ""))}) /Producer (HostelNode) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const slipTemplate = () => String(process.env.WA_TEMPLATE_SETTLEMENT_SLIP || "").trim();
const slipLang = () => String(process.env.WA_TEMPLATE_SETTLEMENT_SLIP_LANG || "en").trim();
const slipOn = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID && !!slipTemplate() && !/^(off|0|false)$/i.test(slipTemplate());

/** Send the slip PDF on WhatsApp. Returns { sent, why }. Never throws. */
async function sendSettlementWhatsApp({ phone, tenantName, property, resultText, slipNo, pdf }) {
  try {
    if (!slipOn()) return { sent: false, why: "off" };
    const { mobileOf, live } = require("./planReceiptWhatsapp");
    const mobile = mobileOf(phone);
    if (!mobile) return { sent: false, why: "no mobile number" };
    const tidy = v => String(v === null || v === undefined ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || "-";
    const filename = "Settlement-" + String(slipNo || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) + ".pdf";
    const mediaId = await live.uploadPdf(pdf, filename);
    await live.sendTemplate("91" + mobile, slipTemplate(), slipLang(), [tenantName, property, resultText, slipNo].map(tidy), mediaId, filename);
    return { sent: true };
  } catch (err) {
    console.error("Settlement slip WhatsApp (non-fatal):", err.message);
    return { sent: false, why: "not sent" };
  }
}

module.exports = { buildSettlementPdf, sendSettlementWhatsApp, slipOn };
