/* ============================================================
   scripts/smoke-test.js  —  Phase 1 (developer tool, not used by the app)

   Logs in as an owner and opens every owner page, reporting any page
   that doesn't return 200 or doesn't render the navbar. Read-only:
   it only sends GET requests after logging in.

   Usage (server must already be running):
     SMOKE_BASE=http://localhost:6060 \
     SMOKE_EMAIL=owner@example.com SMOKE_PASSWORD=secret \
     node scripts/smoke-test.js

   Optional, to also open pages that need a record id:
     SMOKE_MEMBER_ID=...  SMOKE_ROOM_ID=...  SMOKE_LISTING_ID=...  SMOKE_HOSTEL_ID=...  SMOKE_ENQUIRY_ID=...
   With HN_NEW_UI=0 on the server, also set HN_NEW_UI=0 here.
============================================================ */

const BASE  = (process.env.SMOKE_BASE || "http://localhost:6060").replace(/\/$/, "");
const EMAIL = process.env.SMOKE_EMAIL;
const PASS  = process.env.SMOKE_PASSWORD;
const ROLE  = process.env.SMOKE_ROLE || "Owner";

if (!EMAIL || !PASS) {
  console.error("Set SMOKE_EMAIL and SMOKE_PASSWORD (an owner account on this server).");
  process.exit(2);
}

const PAGES = [
  "/user",
  "/user/editOwner",
  "/user/addnewhostel",
  "/user/floors",
  "/user/managefloor",
  "/user/newfloor",
  "/user/allrooms",
  "/user/managerooms",
  "/user/newroom",
  "/user/members",
  "/user/activeMember",
  "/user/newmember",
  "/user/newAdded/successfully",
  "/user/allfeesrecords",
  "/user/upcomingPayments",
  "/user/deureports",
  "/user/revenue",
  "/user/list-property",
  "/user/my-listings",
  "/user/messages",
  "/user/leads",
  "/user/leads?lead=Hot",
  "/user/leads?view=visits",
  "/user/leads?status=New",
  "/user/account/settings",
  "/user/account/billing",
  "/user/account/kyc",
  "/user/notifications",
];

const { SMOKE_MEMBER_ID: M, SMOKE_ROOM_ID: R, SMOKE_LISTING_ID: L } = process.env;
if (M) PAGES.push(`/user/member-edit/${M}/edit`, `/user/members/${M}/addpayment`, `/user/payment-history/${M}`);
if (R) PAGES.push(`/user/managerooms/${R}/edit`);
if (L) PAGES.push(`/user/listing/${L}/edit`);
if (process.env.SMOKE_ENQUIRY_ID) PAGES.push(`/user/newmember?enquiry=${process.env.SMOKE_ENQUIRY_ID}`);

// Pages that render outside the shared layout when HN_NEW_UI=0 (old Messages pages).
const NO_NAVBAR = new Set(process.env.HN_NEW_UI === "0" ? ["/user/messages"] : []);

async function login() {
  const body = new URLSearchParams({ "user[email]": EMAIL, "user[password]": PASS, "user[role]": ROLE });
  const res = await fetch(`${BASE}/user/login`, { method: "POST", body, redirect: "manual" });
  const cookie = (res.headers.get("set-cookie") || "").match(/(?:^|,\s*)token=([^;]+)/);
  if (!cookie) throw new Error(`Login failed (HTTP ${res.status}). Check email/password/role.`);
  return `token=${cookie[1]}`;
}

(async () => {
  const cookie = await login();
  let failures = 0;

  if (process.env.SMOKE_HOSTEL_ID) {
    const res = await fetch(`${BASE}/user/hostel/${process.env.SMOKE_HOSTEL_ID}?next=/user/members`, {
      headers: { cookie }, redirect: "manual",
    });
    const ok = res.status === 302 && res.headers.get("location") === "/user/members";
    console.log(`${ok ? "PASS" : "FAIL"}  switch property → ${res.status} ${res.headers.get("location")}`);
    if (!ok) failures++;
  }

  for (const page of PAGES) {
    const res = await fetch(BASE + page, { headers: { cookie }, redirect: "manual" });
    const html = res.status === 200 ? await res.text() : "";
    const hasNav = /hn2-shell|hn-owner-nav/.test(html);
    // Existing app behaviour: with no property yet, some pages answer with
    // a plain-text "Please select a hostel first." That is expected.
    if (res.status === 200 && /Please select a hostel first/.test(html)) {
      console.log(`INFO  ${page}  (no property yet — plain-text notice, unchanged behaviour)`);
      continue;
    }
    const ok = res.status === 200 && (hasNav || NO_NAVBAR.has(page));
    if (!ok) failures++;
    const why = res.status !== 200 ? `HTTP ${res.status}${res.headers.get("location") ? " → " + res.headers.get("location") : ""}` : (ok ? "" : "no navbar in page");
    console.log(`${ok ? "PASS" : "FAIL"}  ${page}${why ? "  (" + why + ")" : ""}`);
  }

  console.log(`\n${PAGES.length} pages checked, ${failures} failed.`);
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error("Smoke test error:", err.message);
  process.exit(1);
});
