/* ============================================================
   utils/receiptPdf.js  —  plan payment receipt as a PDF

   Builds a one-page A4 PDF receipt in memory (a Buffer). It needs
   no extra package: the page is plain text, lines and boxes in the
   PDF's built-in Helvetica font.

   The built-in font has no rupee sign, so amounts are written "Rs. 899".
   Text outside basic Latin (for example a name typed in Devanagari)
   is shown as "?" in the PDF; the receipt page in Billing shows it fully.
============================================================ */

// Helvetica character widths (per 1000 units) for the printable ASCII range, used to right-align text.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const WB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Keep to what the built-in font can draw.
const clean = v => String(v === null || v === undefined ? "" : v)
  .replace(/₹\s?/g, "Rs. ").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, "-")
  .replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7E]/g, "?").trim();
const esc = s => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const widthOf = (s, size, bold) => { let w = 0; for (const ch of s) w += (bold ? WB : W)[ch.charCodeAt(0) - 32] || 556; return (w * size) / 1000; };
const fit = (s, size, bold, max) => { let t = s; while (t.length > 1 && widthOf(t, size, bold) > max) t = t.slice(0, -1); return t === s ? s : t.slice(0, -2) + ".."; };
const rupees = n => "Rs. " + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(n) || 0);

/**
 * r: { receipt, paidAt, amount, planName, duration, from, until, paymentId, method,
 *      owner: { name, business, place, email, phone }, supportEmail }
 * Returns a Buffer holding the PDF.
 */
function buildReceiptPdf(r) {
  const o = r.owner || {};
  const ops = [];
  const L = 56, R = 539;                                   // left and right page margins (A4 is 595 x 842 points)
  const rgb = (a, b, c) => `${(a / 255).toFixed(3)} ${(b / 255).toFixed(3)} ${(c / 255).toFixed(3)}`;
  const text = (x, y, s, { size = 10, bold = false, color = [16, 35, 27], right = false, max = R - L } = {}) => {
    const t = fit(clean(s), size, bold, max);
    if (!t) return;
    const px = right ? x - widthOf(t, size, bold) : x;
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(...color)} rg ${px.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, color = [226, 236, 231], w = 1) => ops.push(`${w} w ${rgb(...color)} RG ${x1} ${y1} m ${x2} ${y2} l S`);
  const box = (x, y, w, h, color) => ops.push(`${rgb(...color)} rg ${x} ${y} ${w} ${h} re f`);
  const INK = [16, 35, 27], SOFT = [107, 124, 117], GREEN = [10, 125, 76];

  // header band
  box(0, 742, 595, 100, GREEN);
  text(L, 796, "HostelNode", { size: 22, bold: true, color: [255, 255, 255] });
  text(L, 778, "hostelnode.com", { size: 10, color: [222, 245, 233] });
  text(R, 796, "RECEIPT", { size: 22, bold: true, color: [255, 255, 255], right: true });
  text(R, 778, "PAID", { size: 11, bold: true, color: [255, 214, 107], right: true });

  // billed to / receipt details
  let y = 706;
  text(L, y, "Billed to", { size: 9, color: SOFT });
  text(R, y, "Receipt", { size: 9, color: SOFT, right: true });
  y -= 18;
  text(L, y, o.name || "-", { size: 12, bold: true, max: 250 });
  text(R, y, "No. " + (r.receipt || "-"), { size: 11, bold: true, right: true, max: 250 });
  const left = [o.business, o.place, o.email, o.phone].filter(Boolean);
  const right = ["Paid on " + (r.paidAt || "-"), "Razorpay payment ID: " + (r.paymentId || "-"), r.method ? "Method: " + String(r.method).toUpperCase() : ""].filter(Boolean);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    y -= 15;
    if (left[i]) text(L, y, left[i], { size: 10, color: [61, 79, 71], max: 250 });
    if (right[i]) text(R, y, right[i], { size: 10, color: [61, 79, 71], right: true, max: 250 });
  }

  // the one line item
  y -= 34;
  box(L, y - 8, R - L, 26, [242, 250, 246]);
  text(L + 12, y, "Description", { size: 9, bold: true, color: SOFT });
  text(R - 12, y, "Amount", { size: 9, bold: true, color: SOFT, right: true });
  y -= 30;
  text(L + 12, y, `HostelNode ${r.planName || "Plan"} plan - ${r.duration || ""}`, { size: 11, bold: true, max: 340 });
  text(R - 12, y, rupees(r.amount), { size: 11, right: true });
  y -= 15;
  text(L + 12, y, `Valid from ${r.from || "-"} to ${r.until || "-"}`, { size: 9.5, color: SOFT, max: 340 });
  y -= 16;
  line(L, y, R, y);
  y -= 26;
  text(R - 110, y, "Total paid", { size: 12, bold: true, right: true });
  text(R - 12, y, rupees(r.amount), { size: 14, bold: true, color: GREEN, right: true });

  // footer
  y -= 40;
  line(L, y, R, y);
  y -= 18;
  text(L, y, "This is a computer-generated receipt for a payment made online through Razorpay. No signature is needed.", { size: 8.5, color: SOFT });
  y -= 13;
  text(L, y, `Questions? Write to ${r.supportEmail || "hostelnodehelp@gmail.com"} with the receipt number.`, { size: 8.5, color: SOFT });

  // assemble the file
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
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (HostelNode receipt ${esc(clean(r.receipt || ""))}) /Producer (HostelNode) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { buildReceiptPdf };
