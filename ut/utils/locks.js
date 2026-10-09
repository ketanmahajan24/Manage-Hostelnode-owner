/* ============================================================
   utils/locks.js  —  Property Operations Phase 3

   A short lock so two changes to the same room (or the same tenant's
   mobile number in a property) never run at the same moment — for
   example two admissions into the last bed, or the same admission
   sent from two tabs. Works across several app processes: each lock
   is a document whose _id is the lock's name, and _id is always unique.

   withLocks(["room:<id>", "mobile:<hostel>:<mobile>"], async () => { ... })
     → { busy: false, value }  when it ran
     → { busy: true }          when someone else holds a lock (nothing ran)
   A lock left behind by a crash expires after 2 minutes.
============================================================ */

const mongoose = require("mongoose");
const crypto = require("crypto");
const STALE_MS = 2 * 60 * 1000;

async function withLocks(keys, fn) {
  const col = mongoose.connection.collection("hn_locks");
  const token = crypto.randomBytes(12).toString("hex");   // only this request's locks are ever released by it
  const got = [];
  const take = async k => {
    try { await col.insertOne({ _id: k, token, at: new Date() }); got.push(k); return true; }
    catch (e) { if (e && e.code === 11000) return false; throw e; }
  };
  try {
    for (const k of [...new Set(keys.filter(Boolean))].sort()) {   // always in the same order (no deadlock)
      if (await take(k)) continue;
      // Left behind by a crash? Take it over; otherwise someone is saving right now.
      const r = await col.deleteOne({ _id: k, at: { $lt: new Date(Date.now() - STALE_MS) } });
      if (!r.deletedCount || !(await take(k))) return { busy: true };
    }
    return { busy: false, value: await fn() };
  } finally {
    for (const k of got) await col.deleteOne({ _id: k, token }).catch(() => {});
  }
}

module.exports = { withLocks };
