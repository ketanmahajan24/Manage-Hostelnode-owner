/* ============================================================
   utils/monthlyRent.js  —  Property Operations Phase 1

   Adds each living tenant's monthly rent charge, replacing the old
   midnight job in app.js. Fixed here:

   • India time. The rent day is the day of the month the tenant
     joined; in shorter months a 29th/30th/31st joiner is charged on
     the month's last day instead of being skipped.
   • Once per month per tenant, however many times it runs (several
     servers, restarts, a manual re-run). A charge that the old job
     already made this month is recognised, so nobody is charged twice
     on the day this is installed.
   • Catches up: if the server was off on someone's rent day, the
     charge is added on the next run in the same month.
   • Only tenants who live here (not moved out, not removed) and who
     joined before this month (the joining month is charged when they
     are added).
   • A tenant whose room is gone is skipped and logged.

   Never throws.
============================================================ */

const moment = require("moment-timezone");
const { TZ, LIVING, dueDateIn } = require("./tenantOps");

let indexTried = false;
async function ensureIndex(Payment) {
  if (indexTried) return;
  indexTried = true;
  try {
    // A second guard against double charges: one charge per tenant per month.
    await Payment.collection.createIndex(
      { memberId: 1, chargeMonth: 1 },
      { unique: true, partialFilterExpression: { chargeMonth: { $type: "string" } }, name: "one_rent_charge_per_month" }
    );
  } catch (err) {
    console.error("Monthly rent index (non-fatal, the check below still prevents doubles):", err.message);
  }
}

async function runMonthlyRent(now = new Date()) {
  const out = { checked: 0, charged: 0, skipped: 0, errors: 0 };
  try {
    const Member = require("../models/member");
    const Payment = require("../models/payment");
    const Room = require("../models/room");
    await ensureIndex(Payment);

    const today = moment(now).tz(TZ).startOf("day");
    const monthStart = today.clone().startOf("month");
    const nextMonth = monthStart.clone().add(1, "month");
    const key = monthStart.format("YYYY-MM");

    const members = await Member.find({ ...LIVING, joiningDate: { $lt: monthStart.toDate() } },
      { _id: 1, name: 1, user: 1, joiningDate: 1, assignedRoom_id: 1 }).lean();

    for (const m of members) {
      out.checked++;
      try {
        if (!m.joiningDate || isNaN(new Date(m.joiningDate))) { out.skipped++; continue; }
        if (today.isBefore(dueDateIn(m.joiningDate, today))) { out.skipped++; continue; }   // rent day not reached yet

        // Already charged this month? (by this job, or by the old one before this was installed)
        const already = await Payment.exists({
          memberId: m._id, roomFees: { $gt: 0 },
          $or: [
            { chargeMonth: key },
            { chargeMonth: { $exists: false }, paymentDate: { $gte: monthStart.toDate(), $lt: nextMonth.toDate() } },
          ],
        });
        if (already) { out.skipped++; continue; }

        const room = m.assignedRoom_id ? await Room.findById(m.assignedRoom_id, { room_fees: 1 }).lean() : null;
        if (!room) { out.skipped++; console.error(`Monthly rent: ${m.name} has no room, not charged`); continue; }
        const fee = Math.max(0, Number(room.room_fees) || 0);
        if (!fee) { out.skipped++; continue; }

        let pay;
        try {
          pay = await Payment.create({
            user: m.user, memberId: m._id, roomId: room._id,
            roomFees: fee, totalFees: fee, advancedPaid: 0, amountPaid: 0, dueAmount: fee,
            status: "Due", paymentDate: dueDateIn(m.joiningDate, today).toDate(), payableDate: dueDateIn(m.joiningDate, today).toDate(),
            chargeMonth: key,
          });
        } catch (e) {
          if (e && e.code === 11000) { out.skipped++; continue; }   // another run made it a moment ago
          throw e;
        }
        await Member.updateOne({ _id: m._id }, { $addToSet: { payments: pay._id } });
        out.charged++;
      } catch (err) {
        out.errors++;
        console.error("Monthly rent (one tenant, non-fatal):", err.message);
      }
    }
  } catch (err) {
    out.errors++;
    console.error("Monthly rent (non-fatal):", err.message);
  }
  return out;
}

module.exports = { runMonthlyRent };
