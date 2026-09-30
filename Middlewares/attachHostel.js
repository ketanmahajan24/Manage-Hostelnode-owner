/* ============================================================
   Middlewares/attachHostel.js  —  Phase 3

   Same behaviour as the `attachHostel` inside routes/userRoutes.js
   (which is left as it is): loads the owner's properties and the
   selected one into res.locals so the navbar can show the property
   switcher. Used by the routers added/changed in Phase 3 (Leads & CRM,
   Messages). Read-only; never blocks a request.
============================================================ */

const Hostel = require("../models/hostel");

module.exports = async function attachHostel(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next();

    const hostels = await Hostel.find({ owner: userId });
    let selectedHostel = null;

    if (req.session?.selectedHostel) {
      // Only ever one of this owner's own properties.
      selectedHostel = await Hostel.findOne({ _id: req.session.selectedHostel, owner: userId }).catch(() => null);
    }
    if (!selectedHostel && hostels.length > 0) selectedHostel = hostels[0];

    res.locals.hostels = hostels;
    res.locals.selectedHostel = selectedHostel;
    next();
  } catch (err) {
    console.error("attachHostel error (non-fatal):", err.message);
    next();
  }
};
