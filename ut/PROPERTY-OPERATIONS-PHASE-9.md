# Property Operations — Phase 9: Reports, rent reminders, expenses

There are two ZIPs, one for each site. Both were built on what is on GitHub now:
- Owner dashboard: commit 070652a (your "Owner property ops phase 5" commit).
- Main site: commit fd63390 (your "Update HostelNode phase 5" commit).

**Both ZIPs include every phase not yet on GitHub (Phases 6–9).** If Phases 6–8 aren't installed yet, installing these installs them too, and their notes still apply (PROPERTY-OPERATIONS-PHASE-6.md to -8.md).

Your GitHub commits match what I delivered for Phase 5. Your own changes are kept:
- **Owner dashboard:** the line you removed in `views/showPage/memberData/newmember.ejs`, and `.env` in `.gitignore`.
- **Main site:** your `.env` path in `app.js`, and `.env` in `.gitignore`.

**Main site `app.js`:** the Phase 5 ZIP had put back `require('dotenv').config();`. This ZIP's `app.js` has your line again:
```
require('dotenv').config({
  path: '/root/hostelnode-envs/hostelnode.com/.env'
});
```

Phase 9 itself changes only the owner dashboard. The main site's part is the "Pay now" link, which opens My PG (Phase 7).

## Install (do it in this order)

1. **Back up the database** (mongodump, or an Atlas snapshot).
2. **Owner dashboard:** unzip over the repo, then stop the app completely and start the new one.
3. **Main site:** unzip over the repo and restart.

Nothing needs converting. These collections create themselves:
- `expenses`
- `remindersettings`
- `rentreminders`
- `hn_reminder_keys` (makes sure each reminder is sent once)

Bill photos are kept privately in `/secure_uploads/expense-bills` on the owner dashboard server, next to the KYC and profile uploads. They are not public; only the owner who added a bill can open it.

## Switching it on

**Reports and Expenses** work as soon as the dashboard restarts.

**Automatic rent reminders** start the day after install, at 10:00 India time, with a second run at 15:00 for any the morning run couldn't deliver.
- **Email:** on from the start, using the email the app already sends with (`utils/sendMail.js`).
- **WhatsApp:** starts once the two templates below are approved by Meta and their names are set in the **owner dashboard** `.env`. Until then, reminders go by email only, to tenants with an email address.
- **Every owner starts with reminders on** (3 days before, on the due day, 3 days after). Each owner can change or switch this off in Payments → Dues → Reminder settings.

| `.env` name | When it's used | Body to submit to Meta (category Utility, language English) |
|---|---|---|
| `WA_TEMPLATE_RENT_DUE` | On the due day and after it, when the PG takes rent online | Hi {{1}}, your rent of {{2}} for {{3}} {{4}}. Tap Pay now to pay online from My PG, or pay your PG directly. |
| `WA_TEMPLATE_RENT_REMINDER` | Before the due day, and at PGs that take cash only | Hi {{1}}, your rent of {{2}} for {{3}} {{4}}. Please pay your PG. Ignore this message if you have already paid. |

- **The Pay now button:** add it to `WA_TEMPLATE_RENT_DUE` in Meta as a **URL button** with the fixed address `https://hostelnode.com/student/my-pg`.
- **What {{4}} says:** "is due on 13 Oct", "is due today", or "was due on 7 Oct and is still unpaid".
- **Why there's no Pay now before the due day:** that month's rent isn't in the ledger yet, so there is nothing to pay online.

**Optional `.env` lines (owner dashboard):**
- `HN_RENT_REMINDERS=off` stops all reminders.
- `HN_REMINDER_EMAIL=off` stops reminder emails; WhatsApp still goes.
- `HN_REMINDER_EMAIL_MAX=200` is the most reminder emails sent in one run (the default is 200). Gmail allows about 500 emails a day per account, and the same account sends your other emails too.
- `HN_REPORTS=off` shows the old Reports page again.

## What changed: owner dashboard

### Reports
The **Reports** item in the menu now opens the new page.
- **Pickers:** the month (last 24 months), and the property ("All properties" or one), plus **⬇ Excel** and **⬇ PDF** for the tab you are on.
- **Totals on every tab:**
  - Expected
  - Collected
  - Still due (today)
  - Expenses
  - Profit (collected − expenses; a loss shows in red)

**The tabs:**
1. **Money**
   - Collected vs expected for the last 12 months. Tap a month to open it.
   - Collection by way of payment: online (Razorpay), cash, UPI to owner, bank transfer.
   - Move-ins and move-outs.
   - With all properties selected: a table for each property.
2. **Dues**
   - The amounts owed by age (0–15, 16–30, 31–60 and over 60 days), each month counted from its own due day.
   - Who owes: name, property, room, owed since, amount, and when they were last reminded, with **Send reminder**.
3. **Occupancy**
   - Beds filled and free for each property now. Blocked and booked beds are not counted as free.
   - Tenants living there at the end of each month, with move-ins and move-outs.
4. **Leads & bookings**
   - Leads (enquiries on your listings) and bookings paid (not counting declined, expired or cancelled ones).
   - Tenants who moved in from a lead, from a booking, and walk-ins.
   - Lead → tenant rate, this month and for each of the last 12 months.
5. **Expenses & profit**
   - Profit for each property: income collected − expenses.
   - The last 12 months.
   - The expenses list, with **View** (bill), **Edit** and **Delete**.

**Downloads:**
- **Excel** is a CSV file that opens straight in Excel. Amounts are plain numbers so you can add them up. Names and ₹ show correctly.
- **PDF** is an A4 report.
- Both contain the same tables as the page, with all 12 months.

**The numbers match the rest of the dashboard:**
- **Expected and Collected:** the Payments page for that property and month.
- **Still due:** the Dues page.
- **Removed tenants:** left out, as on Payments. The old Reports page counted money a removed tenant had paid; the new page doesn't, so the two can differ when you have removed tenants.
- **Deposits:** a deposit used up at move-out is not counted as collected.

### Expenses
**+ Add expense** (Reports → Expenses & profit) asks for:
- **Category:** electricity, water, staff salary, food, repairs, internet, rent to landlord, or other.
- **Amount** and **date** (not in the future).
- **Property.**
- **Note:** optional, but needed for "Other".
- **Bill:** optional; a photo (JPG, PNG) or PDF up to 5 MB. The file itself is checked, not just its name.

To change an expense, use **Edit**: you can change any field, replace the bill or remove it. **Delete** keeps the record but stops counting it.

### Rent reminders
**Payments → Dues → Reminder settings:**
- Turn automatic reminders on or off.
- Set the days: before the due day (1–10), on the due day, and after it if still unpaid (1–15). Each can be ticked off.
- Turn reminders on or off for each property.
- See whether WhatsApp and email are working, and how many tenants have an email address.

**Who gets a reminder:**
- Only tenants who live there and owe money. Before the due day, only if their advance doesn't already cover the rent.
- Never tenants who moved out, were removed, or have paid.
- Each reminder is sent once. A tenant gets at most one reminder a day, automatic or sent by hand.

**What it says:** the amount, the PG and the due date.
- **When the PG takes rent online:** a **Pay now** button that opens My PG on hostelnode.com.
- **At a cash-only PG:** "pay your PG directly" instead of the button.
- **Email:** also lists the months the money is for.

**Dues (and Reports → Dues):**
- Each tenant shows when they were last reminded ("Today 10:00 am · auto", "5 Oct · by you").
- **Send reminder** sends one now, once a day per tenant.
- **💬 Remind** still opens your own WhatsApp, as before.

## Test list for UAT

1. **Reports.** Open Reports. For one property and this month, Expected and Collected match Payments, and Still due matches Dues. Switch property and month, then try each tab.
2. **Downloads.** Download Excel on Money and on Dues, and check they open in Excel with the right numbers. Download a PDF.
3. **Add an expense.** Add an electricity expense with a bill photo. It shows under Expenses & profit, View opens the photo, and Profit goes down by the amount.
4. **Edit and delete.** Edit the expense (new amount, remove the bill), then delete it. Profit goes back.
5. **Reminder settings.** Switch one property off and save. Change "days before" to 5.
6. **Email reminder.** Give a tenant who owes money your own email address, then press **Send reminder** on Dues. The email arrives with the amount. If the PG takes rent online, it has **Pay now**, which opens My PG.
7. **WhatsApp reminder.** Once the templates are approved and set in `.env`, repeat step 6 with a tenant who has your mobile number.
8. **Once a day.** Press Send reminder again for the same tenant. It is refused for today.
9. **No reminder needed.** A tenant who has paid, or who moved out, has no Send reminder.
10. **Phones.** On a phone, check Reports (the chart, the tabs and the tables), Add expense, Reminder settings and Dues.

## Tests run before delivery

**New Phase 9 tests: 119 checks, all passing.** They cover:

*Reports*
- Every number checked against figures worked out independently from the ledgers, and against the Payments and Dues pages: all properties, one property, this month and past months, and the 12-month chart.
- Online, cash, UPI and bank amounts; a cancelled payment, a deposit used at move-out, and a removed tenant.
- Dues by age; occupancy with blocked beds; move-ins and move-outs.
- Leads by listing and property, with bookings (declined ones not counted).
- Bad month, property and tab values; another owner's property never shown.

*Expenses*
- Add, edit, delete and view the bill.
- Refused inputs: amount, future date, a property of another owner, "Other" without a note, a fake photo, a file over 5 MB, and a file that isn't a photo or PDF.
- A double tap saves once, the typed form is kept after an error, and another owner can't open, edit or delete an expense.

*Downloads*
- CSV that Excel reads, with the same numbers. A note that looks like an Excel formula is written as text.
- PDFs for all five tabs that open and contain the numbers.

*Reminders*
- Before, on, and after the due day; online vs cash-only PGs; WhatsApp and email.
- Never to tenants who are paid up, moved out, removed, not yet due, or at an owner or property switched off.
- Sent once, even with two runs at the same moment.
- A reminder that reached no one is tried again; one left half-sent by a restart is picked up later.
- Broken old tenant records don't stop the run; the email limit holds.
- Send reminder: once a day, refusals explained, another owner's tenant not reachable.

*Switches*
- `HN_REPORTS=off` shows the old page.

**Earlier suites rerun, all passing:**

| Suite | Checks |
|---|---|
| Phase 8 | 127 |
| Phase 7 | 150 |
| Phase 6 | 101 |
| Phase 5 | 121 |
| Phase 4 | 96 |
| Phase 3 | 123 |
| Phase 2 | 95 |
| Phase 1 | 82 |
| Billing and plans | 106 + 167 + 17 |
| Payments | 108 |
| Admin | 44 |
| Upgrade popup | 65 |
| Listings and leads | 20 + 27 |
| Owner page smoke test | 37 pages |

The Phase 1 check on the old Reports page was updated to expect the new page.

**Independent code review: three rounds.** Everything found was fixed and tested again:
- "Send reminder" limited to once a day per tenant, together with automatic reminders.
- A failed send no longer blocks a retry.
- One broken tenant record can't stop everyone's reminders, and the run now works one owner at a time.
- Reminders that couldn't be delivered are retried.
- An email limit for each run.
- Declined bookings are no longer counted, and the lead → tenant rate is corrected.
- An unsupported bill file is refused with a message instead of being dropped silently.
- A reminder left half-sent by a restart is picked up later.

**Known and not changed:**
- hostelnode.com /admin and /admin/hostels return an error, as on GitHub now.
- The listing page shows a browser error in the console when scrolling, also on the code before this phase.

## One thing to decide (not changed)

`utils/sendMail.js` (owner dashboard) has the Gmail address and app password written in the code, so they are on GitHub. I recommend moving them to `.env` (for example `MAIL_USER` and `MAIL_PASS`) and creating a new app password in Google. I didn't change it because it is outside this phase; say the word and I'll do it.
