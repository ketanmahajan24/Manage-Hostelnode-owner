/* ============================================================
   scripts/kyc-review.js  —  Redesign Phase 4 (admin tool)

   Approve or reject an owner's KYC submission from the server, until
   the hostelnode.com admin panel supports KYC. Uses MONGO_URL from .env.
   Only acts on submissions that are "Pending".

     node scripts/kyc-review.js list
     node scripts/kyc-review.js approve owner@example.com
     node scripts/kyc-review.js reject  owner@example.com "Photo is blurry"

   The document itself is at /secure_uploads/kyc/<file> on the server
   (the file name is shown by `list`).
============================================================ */

require("dotenv").config();
const mongoose = require("mongoose");
const Owner = require("../models/owner");

const [, , action, email, ...reasonParts] = process.argv;
const reason = reasonParts.join(" ").trim();

(async () => {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is not set.");
  await mongoose.connect(process.env.MONGO_URL);

  if (action === "list") {
    const rows = await Owner.find({ "kyc.status": "Pending" }, { name: 1, email: 1, kyc: 1 }).sort({ "kyc.submittedAt": 1 }).lean();
    if (!rows.length) console.log("No pending KYC submissions.");
    for (const o of rows) {
      console.log(`${o.email}  ${o.name}  ${o.kyc.docType} ${o.kyc.docNumberMasked}  submitted ${o.kyc.submittedAt?.toISOString().slice(0, 10)}  file ${o.kyc.docFile}`);
    }
    return;
  }

  if (!["approve", "reject"].includes(action) || !email) {
    console.log('Usage: node scripts/kyc-review.js list | approve <email> | reject <email> "<reason>"');
    process.exitCode = 2;
    return;
  }
  if (action === "reject" && !reason) {
    console.log("Give a reason for the owner, e.g.: reject owner@example.com \"Photo is blurry\"");
    process.exitCode = 2;
    return;
  }

  const res = await Owner.updateOne(
    { email: email.toLowerCase().trim(), "kyc.status": "Pending" },
    { $set: {
      "kyc.status": action === "approve" ? "Verified" : "Rejected",
      "kyc.reviewedAt": new Date(),
      "kyc.rejectionReason": action === "reject" ? reason.slice(0, 300) : "",
    } },
    { runValidators: true }
  );
  console.log(res.modifiedCount ? `Done: ${email} is now ${action === "approve" ? "Verified" : "Rejected"}.` : `No pending KYC found for ${email}.`);
})()
  .catch(err => { console.error("Error:", err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
