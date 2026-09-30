/* ============================================================
   routes/leadsRoutes.js  —  Phase 3: Leads & CRM
   Mounted at /user in app.js:
     GET  /user/leads                   the Leads & CRM page
     POST /user/enquiries/:id/status    change one enquiry's status
   "Convert to tenant" is a link to the existing Add Tenant page
   (/user/newmember?enquiry=<id>), which pre-fills from the enquiry.
============================================================ */

const express = require("express");
const router  = express.Router();

const { jwtAuthMiddleware } = require("../jwt.js");
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
const { buildLeadsPage, setEnquiryStatus } = require("../utils/leads");

// Where to go back to after a status change: only the Leads page itself.
function safeReturn(p) {
  return typeof p === "string" && /^\/user\/leads(\?[\w=&%.+-]*)?$/.test(p) ? p : "/user/leads";
}

// Canonical URL for the current filters (used to come back after a change).
function leadsUrl(filters, page) {
  const qs = new URLSearchParams();
  for (const k of ["listing", "lead", "status", "view"]) if (filters[k]) qs.set(k, filters[k]);
  if (page > 1) qs.set("page", String(page));
  const q = qs.toString();
  return "/user/leads" + (q ? "?" + q : "");
}

router.get("/leads", jwtAuthMiddleware, attachHostel, async (req, res) => {
  try {
    const user = await Owner.findById(req.user.id);
    if (!user) return res.redirect("/login");
    const leads = await buildLeadsPage(user._id, req.query);
    res.render("leads/index.ejs", {
      user,
      leads,
      notice: req.query.updated === "1" ? "Status updated." : req.query.updated === "0" ? "That status change could not be saved." : "",
      currentUrl: leadsUrl(leads.filters, leads.page),
    });
  } catch (err) {
    console.error("Leads page error:", err.message);
    res.status(500).send("Something went wrong loading your leads. Please try again.");
  }
});

router.post("/enquiries/:id/status", jwtAuthMiddleware, async (req, res) => {
  const back = safeReturn(req.body.returnTo);
  const sep = back.includes("?") ? "&" : "?";
  try {
    const ok = await setEnquiryStatus(String(req.params.id || ""), req.user.id, String(req.body.status || ""));
    res.redirect(back + sep + "updated=" + (ok ? "1" : "0"));
  } catch (err) {
    console.error("Enquiry status error:", err.message);
    res.redirect(back + sep + "updated=0");
  }
});

module.exports = router;
