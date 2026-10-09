# Property Operations — Phase 3: tenants and admissions

There are two ZIPs, one for each site. Both were built on what is on GitHub now:
- Owner dashboard: commit e465e7e (your Phase 1 install).
- Main site: commit b55bc57.

**Both ZIPs include Phase 2.** Phase 2 isn't on GitHub yet, so installing these installs Phase 2 and Phase 3 together. Read PROPERTY-OPERATIONS-PHASE-2.md as well, because its steps still apply.

## Install (do it in this order)

1. **Back up the database** (mongodump, or an Atlas snapshot).
2. **Owner dashboard (manage.hostelnode.com).**
   - Unzip over the repo, keeping the same folders.
   - **Stop the running app completely, then start the new one.** Don't run the old and new versions side by side.
3. **Phase 2's one-time bed setup** (skip it if you already ran it):
   ```
   node scripts/recount-beds.js           # shows what it would change; changes nothing
   node scripts/recount-beds.js --apply   # makes the changes
   ```
4. **Main site (hostelnode.com).**
   - Unzip over the repo.
   - Make sure `.env` has `HN_OWNER_DASHBOARD_URL=https://manage.hostelnode.com` (from Phase 2).
   - Restart.
5. **Tenant documents folder.** Uploaded tenant documents go to `/secure_uploads/tenant-docs` on the owner dashboard server. That's the same private area as owner KYC files, and it isn't served to the public. The folder is created by itself; it just needs to be on a disk that survives restarts and is backed up, like `/secure_uploads/kyc`.

Nothing in the database needs converting. Existing tenants keep working as they are:
- Their rent day stays their joining day until you change it.
- Their rent stays the bed's rent.
- Their deposit shows as "None" until you set it.

**New collections** (created by themselves):
- `tenantevents`: the tenant history.
- `hn_locks`: tiny short-lived locks, so two admissions into the same bed can't happen at the same moment.

Neither needs any setup.

## WhatsApp messages (optional; switch on after Meta approves the templates)

Two new messages go from HostelNode's WhatsApp number, the one that sends OTPs. Both stay off until you add the template name to the owner dashboard `.env`. Until then, everything else works and nothing is sent.

Create both templates in Meta WhatsApp Manager, with category **Utility** and language **English (en)**.

**1. Welcome to a new tenant**

Name: `hostelnode_tenant_welcome`. No header.

Body:
```
Hi {{1}}, welcome to {{2}}! Your room is {{3}}, bed {{4}}.
Rent: {{5}} a month, due on the {{6}} of every month.
```
Samples for Meta: Vikas · Sai PG · 102 · A · ₹6,000 · 1st

When approved, add `WA_TEMPLATE_TENANT_WELCOME=hostelnode_tenant_welcome` to `.env` and restart.

**2. Settlement slip at move-out**

Name: `hostelnode_settlement_slip`. Header: **Document** (upload any sample PDF when Meta asks).

Body:
```
Hi {{1}}, your stay at {{2}} is settled. {{3}}.
Settlement slip no. {{4}} is attached.
```
Samples for Meta: Karan · Sai PG · Refund: ₹5,750 · SL-2026-0031

When approved, add `WA_TEMPLATE_SETTLEMENT_SLIP=hostelnode_settlement_slip` to `.env` and restart.

Optional: if WhatsApp Manager shows a different language code, set `WA_TEMPLATE_TENANT_WELCOME_LANG` or `WA_TEMPLATE_SETTLEMENT_SLIP_LANG` (for example `en_US`).

## What changed: owner dashboard

**Tenants** (`/user/members`)
- The money comes first: "₹12,000 due from 2 tenants", plus living, moving out and KYC counts.
- Tabs: Living, Moving out and Moved out.
- Search finds a name, part of a mobile number, or a room.
- Filters: floor, has dues, KYC not done.
- Each row shows the room and bed, rent and due day, this month (Paid ✓ / ₹ due · N days late / Due 20 Oct) and a KYC badge.
- Each row has Call, WhatsApp and Open buttons. Mobile numbers are masked in the list.
- On phones the rows become cards.

**Add tenant** (`/user/newmember`) has 3 steps:
1. **Person.** Name, mobile, gender, email, date of birth, college or work, address, guardian and emergency contact.
2. **Room and money.**
   - The bed comes from the free beds only.
   - Joining date.
   - Rent: filled in from the bed, and can be changed for this tenant.
   - Due day: defaults to the joining day.
   - Deposit: suggested as one month's rent; any amount.
   - Whether the deposit and the first month's rent were paid now, and how. The owner must choose, so nothing is recorded as paid by mistake.
3. **Check and confirm**, then Admit tenant.

**Rent months charged at admission:**
- **Joined this month:** charged from the joining day.
- **Rent due day different from the joining day:** the first charge can be edited, and a pro-rata amount is suggested. For example, joining on 28 Oct with rent on the 1st gives "₹774 for 28–31 Oct".
- **Joined in an earlier month** (adding an existing tenant):
  - The rent period running now is charged.
  - The owner must choose, for the months before it: **Already paid** (nothing added) or **Add to dues** (each month added; the joining month pro-rata).

Also:
- **From Leads & CRM**, "Admit as tenant" fills in the student's name, mobile, email, gender, date of birth and college. The owner checks and edits them.
- After admission the lead shows "Became tenant", which links to the tenant.
- The same mobile can't be admitted twice into one property. A double click admits once.

**Tenant page** (`/user/tenants/<id>`)
- **Header:** room and bed, status, KYC, Call, WhatsApp, and Collect ₹X.
- **Overview:**
  - Stay: rent, due day, deposit, this month, leaving date.
  - Change room. The tenant keeps their rent unless "Charge the new bed's rent" is ticked.
  - Give notice: leaving date and reason. The tenant stays Living until moved out.
  - Edit rent, due day or deposit. Applies from the next monthly rent.
  - Record deposit received.
  - Person details, with Edit.
- **Payments:** charged, paid and due, every entry, and receipt links.
- **Documents:** upload PDF, JPG or PNG up to 5 MB. Only that owner can open or delete them.
- **History:** admitted, moves, rent and due-day changes, deposit, notice, move-out and every payment, with who did it.

**Move out** (`/user/tenants/<id>/move-out`)
- The screen shows the deposit held minus unpaid rent and any deductions you type (damage, electricity…).
- The result is "Refund ₹X" (paid by cash, UPI or bank) or "Collect ₹X".
- It makes a settlement slip PDF (SL-2026-0001…).
- The bed becomes free, and the listing shows it free again.
- In the payment records, the deposit pays the unpaid rent first, then the deductions. Anything still owed shows in Dues.
- **Undo move-out** works for 24 hours, if the bed is still free.

**Monthly rent**
- Charged on each tenant's own due day.
- A tenant leaving on or before a month's due day isn't charged for that month.

**Elsewhere**
- **Sidebar:** under Tenants: All Tenants, Add Tenant, Moving Out. The old "Active Tenants" page now opens Tenants.
- **Old addresses:** old tenant edit links open the tenant page. The old search goes to the Tenants search.

## What changed: main site
- `models/member.js` is the same as the owner dashboard's, so neither app drops the other's new fields.
- `/user/tenants/...` on hostelnode.com sends owners to manage.hostelnode.com, like the other owner pages since Phase 2.

## Things to know
- **KYC:** shows "Not done" for everyone until DigiLocker KYC (Phase 4). Admission is allowed until then; after Phase 4, a tenant can only be admitted after KYC.
- **Deposits:** they aren't counted as income in Reports, because they're the tenant's money. Only the part kept at move-out (for dues or deductions) shows up, as a payment called "Deposit adjusted".
- **Tenants who moved out before this update** don't have a settlement slip. Their page says so.
- **Leaving date passed:** rent isn't charged for months after a tenant's leaving date. If the date passes and they haven't been moved out, the Tenants list flags it ("Was leaving 3 Oct") and their page asks you to move them out or change the date.
- **Old one-page form:** an Add Tenant page that was still open in a browser during the update still saves, the same way as before (first free bed in the room, nothing marked paid).

## Test list for UAT
1. Tenants page: the counts match, Living, Moving out and Moved out tabs work, search by name, mobile and room, and the Has dues filter works.
2. Add tenant (walk-in): fill step 1, pick a bed, then try to go on without choosing "paid now?". It stops and asks.
2a. Add an existing tenant with a joining date 3 months ago. The form asks about the earlier months. Choose "Already paid": only the current month is charged.
2b. Set the joining date to today and the due day to the 1st. "Rent for … (N days)" appears with a pro-rata suggestion.
3. Choose deposit Cash and rent Part ₹2,000. Step 3 shows the summary. Admit: the tenant page shows ₹X due, and Dues lists them.
4. Add the same mobile again. It's refused with the name and room of the tenant already living there.
5. Leads & CRM: Admit as tenant. The details come filled in; change one and admit. The lead shows "Became tenant", which links to the tenant.
6. Tenant page: edit details, then change the rent to ₹500 more and the due day. History shows each change "by you".
7. Record deposit received: try more than what's left (refused), then the right amount.
8. Change room: move to a bed with a higher rent, leaving the box unticked. The rent stays the same. Move again with the box ticked: the rent becomes the bed's rent.
9. Give notice for 20 days from today. The tenant shows in Moving out with the date, and the bed map shows the bed. Cancel the notice.
10. Move out with one deduction. Check the refund or collect amount, then open the slip PDF.
11. After a move-out with an amount to collect: the tenant shows in Dues with that amount.
12. Undo the move-out within 24 hours. The tenant is living in the same bed again, and the slip is gone.
13. Documents: upload a PDF and a photo, open them, delete one. Open the document link in another browser where you're not logged in: it doesn't open.
14. Old links: /user/activeMember opens Tenants. On hostelnode.com, /user/members goes to manage.hostelnode.com.
15. Phone: Tenants list, Add tenant (all 3 steps), tenant page and Move out all fit the screen without sideways scrolling.
16. Plan limit (if switched on): at the tenant limit, Add tenant shows the upgrade popup as before, and the draft is filled back in after upgrading.

## Tests run before delivery
- **New Phase 3 tests: 122 checks, all passing.** They cover:
  - Admission (walk-in, from a lead, validation, duplicates, the same form sent 3 times at once).
  - Back-dated tenants and pro-rata.
  - Money records.
  - Due day and the monthly rent job.
  - Notice, move-out settlement in each case, the slip PDF, and undo.
  - Documents.
  - Another owner being unable to see or change anything (every new address tried).
  - Old addresses.
  - WhatsApp welcome and slip (with a WhatsApp stand-in).
  - The main-site redirect.
- **Earlier suites rerun, all passing:**
  - Phase 2: 95 checks.
  - Phase 1: 82 checks.
  - Billing and plans: 106 checks.
  - Payments: 108 checks.
  - Listings and leads: 156 + 17 + 20 + 27 checks.
  - Admin: 44 checks.
  - Upgrade popup and drafts: 65 checks.
  - Page smoke test: 32 pages.
- **Form check:** the form's month calculation matches the server's for 427 joining-date and due-day combinations.
- **Independent code review, three rounds.** Everything found was fixed and tested again. Fixes included:
  - Recording a deposit for older tenants.
  - Two admissions or move-outs at the same moment.
  - Back-dated months.
  - Pro-rata.
  - Undo after a re-admission.
