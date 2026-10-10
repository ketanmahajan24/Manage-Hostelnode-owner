# Property Operations — Phase 8: booking a bed from a listing

There are two ZIPs, one for each site. Both were built on what is on GitHub now:
- Owner dashboard: commit d6332a8 (your "phase 4" commit).
- Main site: commit a428045 (your "phase 4" commit).

**Both ZIPs include every phase not yet on GitHub (Phases 5–8).** If Phases 5–7 aren't installed yet, installing these installs them too, and their notes still apply (PROPERTY-OPERATIONS-PHASE-5.md to -7.md).

Your GitHub commits match what I delivered for Phases 2–4. One extra file is harmless and can be deleted: the main site has a stray copy of the admin KYC page at `views/kyc.ejs` (the real one is `views/admin/kyc.ejs`).

Students now book a bed from a listing and pay a booking amount online. The owner accepts with the exact bed, or declines (full refund). On move-in day, Admit fills in the tenant form and credits the booking amount.

## Install (do it in this order)

1. **Back up the database** (mongodump, or an Atlas snapshot).
2. **Owner dashboard:** unzip over the repo, then stop the app completely and start the new one.
3. **Main site:** unzip over the repo and restart.

Nothing needs converting. One new collection creates itself: `bookings`. Booking numbers (BK-2026-0001…) are kept in `hn_counters`.

**Shared files: keep them identical in both repos.**
- New: `models/booking.js`, `utils/bookings.js`, `utils/beds.js` (new on the main site).
- Changed: `models/listingProperty.js`, `models/payment.js`, `models/Notification.js`.
- Still shared from earlier phases: the Phase 7 list in PROPERTY-OPERATIONS-PHASE-7.md.

## Switching it on

Nothing new in `.env`. Booking uses the same Razorpay keys and webhook as Phase 7 (both sites), and the same DigiLocker KYC as Phase 4.

**When students see "Book" on a listing (all must be true):**
- The listing is linked to the owner's property (Phase 2: My Listings → Show real free beds), so free beds are real.
- The owner switched **Online booking** on for that listing.
- The owner's payout account is **Active** (Phase 6).
- The room type has a free bed.

**Off switch:** `HN_BOOKINGS=off` in either `.env` stops new bookings. Open bookings are still answered, refunded and admitted as usual.

**Optional WhatsApp messages.** Each one needs a Meta-approved template (category Utility, language English). Set the template's name in **both** `.env` files. Until a name is set, that message simply isn't sent.

| `.env` name | Sent to | Body to submit to Meta |
|---|---|---|
| `WA_TEMPLATE_BOOKING_REQUESTED` | Student | Hi {{1}}, your booking request at {{2}} ({{3}}, move-in {{4}}) is sent. You paid {{5}}. Booking no. {{6}}. The PG answers within 48 hours; if they decline or don't answer in 72 hours, you get a full refund. |
| `WA_TEMPLATE_BOOKING_ACCEPTED` | Student | Hi {{1}}, {{2}} accepted your booking: {{3}}, moving in on {{4}}. Booking no. {{5}}. Bring your ID on the day. |
| `WA_TEMPLATE_BOOKING_CANCELLED` | Student | Hi {{1}}, your booking at {{2}} is cancelled because {{3}}. Refund: {{4}} (usually 5–7 working days to your bank). Booking no. {{5}}. |
| `WA_TEMPLATE_BOOKING_NEW` | Owner | New booking on HostelNode: {{1}} booked {{2}} at {{3}}, moving in on {{4}}, and paid {{5}}. Please accept or decline in your dashboard within 48 hours. |
| `WA_TEMPLATE_BOOKING_REMINDER` | Owner | Reminder: {{1}}'s booking at {{2}} is waiting for your answer. It is cancelled and refunded on {{3}} if not answered. |

## What changed: hostelnode.com (students)

- **On a listing:** each room type with free beds gets a **Book** button next to Enquire. The side card gets **Book now** next to Contact Owner ("5 beds free · pay ₹6,000 to book · refundable until accepted"). On phones, the bottom bar's View Rooms becomes **Book now**.
- **Book a bed** (`/student/book/<listing>`):
  - Choose the room type (with live free beds) and a move-in date (today to 60 days ahead).
  - **Aadhaar KYC:** verified students see their verified name. Others get **Verify with DigiLocker**, which comes straight back to the booking with their choices kept. Pay stays off until they're verified.
  - The page shows the booking amount, the payment fee (if the tenant pays it), the total, what it counts towards, and the **cancellation rule**, all before paying. Then Razorpay checkout.
- **Booking requested:** the deadline for the owner's answer, the booking number, Requested → Accepted → Moved in, and the refund promise.
- **My bookings** (in the student menu once they've booked): each booking with its status, the bed once accepted, refunds, and **Cancel**. Cancel shows the exact refund first. If the booking changed meanwhile (for example the owner just accepted), the student is asked to check again.
- **One open booking per PG for each student.** If two are paid from two tabs, the later one is cancelled with a full refund.

## What changed: owner dashboard

- **Bookings** (new in the menu, with a count of bookings waiting for an answer):
  - Tabs: Requested, Accepted, Moved in, Declined & cancelled.
  - Each row shows the KYC badge, room type, move-in date, amount paid and hours left to answer.
  - **Answer:** the verified name, then **Pick the bed**. Only beds free on the move-in date are offered, matching type first; beds whose tenant leaves before then count as free.
  - **Accept booking**, or **Decline** with a reason (full refund).
  - Accepted bookings have **Admit** and, if needed, **Cancel booking** (full refund). From the day after the move-in date, **Didn't move in** closes it by the listing's rule.
- **Bed map:** an accepted booking's bed shows as **Booked · name · date**. No one else can be admitted into it, moved into it or put back into it by an undo, and it can't be blocked or removed, until the booking is cancelled or the student moves in. The listing's free beds count it too.
- **Admit:** opens Add tenant filled in from the booking (verified name, mobile, email, the booked bed, move-in date).
  - On save, the booking amount is credited: as a payment in the ledger with a receipt ("Paid online by tenant"), or to the deposit.
  - The owner's share is then released to their bank.
  - If the owner admitted the student with the normal Add tenant form instead, the booking is credited automatically within 15 minutes.
- **My Listings → listing → Show real free beds:** a new **Online booking** box.
  - On or off.
  - Amount: one month's rent of the room type (suggested), or a fixed ₹.
  - Counts towards: first month's rent or deposit.
  - If the student cancels after you accept: full, half or no refund, up to N days before move-in (none after).
- **Reminders:** at 24 and 48 hours without an answer the owner gets a dashboard notification (and WhatsApp, if set). **At 72 hours the booking is cancelled and refunded in full automatically.** A day after the move-in date without Admit, the owner is asked "Did X move in?".

## What changed: your admin

**Payouts → an owner:**
- **Hold / Release** now also covers booking money that is already the owner's.
- **Bookings needing attention** lists two rare cases:
  - A refund Razorpay kept refusing, with **Try again**.
  - A second payment on the same booking, with **Mark refunded** once you've refunded it in Razorpay.

## How the money moves

- The student pays HostelNode's Razorpay account. The order carries a Route transfer of the owner's share, **on hold**, so it doesn't reach the owner's bank until the student moves in.
- **Refunds are automatic:** HostelNode takes back the owner's share (a transfer reversal) and refunds the student. Each step checks what Razorpay already did, so nothing is ever refunded twice. If Razorpay can't be reached, it's tried again every 15 minutes.

| Case | Student gets back | Owner keeps |
|---|---|---|
| Owner declines, no answer in 72 h, owner cancels, or student cancels before acceptance | Everything they paid (fee included) | Nothing |
| Student cancels after acceptance, before the cut-off | By the rule: all, half of the booking amount, or nothing | The rest, released to their bank |
| After the cut-off, or "Didn't move in" | Nothing | All, released to their bank |
| Moves in | — | Credited to rent or deposit, released to their bank |

- **Every amount is worked out on the server.** A booking counts only after Razorpay confirms the money was collected (the browser with the signature checked, the webhook, or the booking page asking Razorpay).

## Test list for UAT (Razorpay test keys)

1. **Set up.** For an owner with an **Active** test payout account, link a listing to their property, then switch Online booking on (one month's rent, first month's rent, half refund up to 7 days).
2. **The listing.** On hostelnode.com, as a student, the listing shows **Book** on room types with free beds and **Book now** in the side card.
3. **KYC.** Book a bed as an unverified student: Verify with DigiLocker comes back to the same choices. After verifying, Pay is on.
4. **Pay.** Pay with Razorpay's test UPI. "Booking requested" appears, and My bookings is in the menu.
5. **Bookings page.** In the owner dashboard, Bookings shows the request with ✓ KYC. Answer, pick a bed, Accept: the bed map shows it **Booked**, and the student's booking shows the bed.
6. **Razorpay.** In the test dashboard, Route → Transfers shows the transfer **on hold**.
7. **Student cancels.** Book again (another student) and Decline: the full amount is refunded, and the transfer is reversed. As a third student, cancel after acceptance more than 7 days ahead: half is refunded.
8. **Move in.** For the accepted student, press **Admit**: the form is filled in. Save: the ledger shows the booking amount paid, and the transfer is released.
9. **No answer.** Leave a booking unanswered: reminders arrive, and after 72 hours it's cancelled and refunded. (To try it quickly, ask me for the one-line database change.)
10. **Phones.** On a phone: the listing, Book a bed, My bookings and the owner's Bookings drawer fit the screen.

## Tests run before delivery

- **New Phase 8 tests: 127 checks, all passing**, against a Razorpay stand-in. They cover:
  - Book buttons on, off, or hidden (no payout account, no keys), and free beds counting waiting and accepted bookings.
  - The KYC step and the way back from DigiLocker, and refused orders (full type, dates, not verified, owner can't receive, logged out).
  - The Route transfer on hold, and order reuse.
  - Bad signatures, another student, verify plus webhook, the webhook-only path, and the booking page asking Razorpay.
  - Accept: owner-only, occupied beds refused, and two accepts for one bed at the same moment.
  - Decline with refund, student cancels (full, half, none), 24 and 48 hour reminders, 72 hour expiry with refund.
  - A refund Razorpay refused, retried, then admin **Try again**.
  - Two tabs paying two bookings, a second payment on a paid booking, and a refund changed by the owner's answer.
  - **Didn't move in.**
  - Admit: pre-filled form, booked bed protected, rent and deposit credit, release.
  - The normal-form admission credited by the 15-minute job.
  - A different mobile number not credited (unless admitted from the booking into its bed).
  - The property switch keeping Admit, the listing settings, and shared files being identical.
- **Earlier suites rerun, all passing:**

  | Suite | Checks |
  |---|---|
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
- **Independent code review: three rounds.** Everything found was fixed and tested again. Fixes included:
  - Two paid bookings at one PG.
  - A refund changed under the student.
  - No-shows.
  - Admit from another property.
  - Booked beds reachable by undo, room edits and old tenant records.
  - Credits that didn't happen at admission.
  - Refunds made before Razorpay's transfer existed.
  - The half-refund maths.
  - Accepted bookings never cancelled automatically.
- **Known and not changed:**
  - hostelnode.com /admin and /admin/hostels return an error, as on GitHub now.
  - The listing page shows a browser error in the console when scrolling, also on the code before this phase. It has no visible effect.
