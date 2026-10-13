# Property Operations — Phase 7: online rent payment by tenants

There are two ZIPs, one for each site. Both were built on what is on GitHub now:
- Owner dashboard: commit e465e7e (your Phase 1 install).
- Main site: commit 725141c (your "Owner property ops phase 2" commit).

**Both ZIPs include every phase not yet on GitHub (owner dashboard: Phases 2–7; main site: Phases 3–7).** If earlier phases aren't installed yet, installing these installs them too, and their notes still apply (PROPERTY-OPERATIONS-PHASE-2.md to -6.md).

Tenants now pay rent from **My PG** on hostelnode.com. Razorpay Route sends the owner's share straight to the bank account they added in Phase 6, and the owner's ledger shows it as paid at once.

## Install (do it in this order)

1. **Back up the database** (mongodump, or an Atlas snapshot).
2. **Owner dashboard (manage.hostelnode.com).**
   - Unzip over the repo, keeping the same folders.
   - Stop the running app completely, then start the new one.
3. **Main site (hostelnode.com).**
   - Unzip over the repo.
   - Add the `.env` lines below, then restart.

Nothing in the database needs converting. One new collection creates itself: `rentorders`, one per payment a tenant starts.

**Shared files: keep them identical in both repos.**
- Models: `payment.js`, `member.js`, `hostel.js`, `rentOrder.js`, `payoutAccount.js`, `payoutSettings.js`.
- Utils: `onlineRent.js`, `ledger.js`, `payments.js`, `tenantOps.js`, `tenants.js`, `ledgerPdf.js`, `settlementPdf.js`, `planReceiptWhatsapp.js`, `razorpay.js`, `payouts.js`, `locks.js`.

## Switching it on

1. **hostelnode.com `.env`**: add the **same** Razorpay keys the owner dashboard uses (tenants pay on hostelnode.com):
   ```
   RAZORPAY_KEY_ID=rzp_live_xxx        (or rzp_test_xxx to try it first)
   RAZORPAY_KEY_SECRET=xxx
   ```
   Optional: to send the rent receipt on WhatsApp after a tenant pays, also add the template you set up in Phase 5:
   ```
   WA_TEMPLATE_RENT_RECEIPT=hostelnode_rent_receipt
   ```
   (The site already has `WA_TOKEN` and `WA_PHONE_ID` for OTPs.)
2. **Razorpay webhook.** In Razorpay Dashboard → Webhooks, edit the same HostelNode webhook (`https://manage.hostelnode.com/payments/razorpay/webhook`) and make sure these are ticked:
   - `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`
   - `refund.processed`
   - `transfer.processed`, `transfer.failed`, `settlement.processed`

   The webhook is the backup if a tenant closes the page right after paying. Payout status is also checked every 30 minutes.
3. **Owner dashboard `.env`:** `HN_MAIN_SITE_URL=https://hostelnode.com` (already there from Phase 4; it is used for the invite link).
4. **Fees** are the ones you set in admin → Payouts → Fees & commission (Phase 6).

**Off switch:** `HN_ONLINE_RENT=off` in either `.env` stops new online payments. Everything already paid stays.

**When "Pay rent" shows for a tenant (all must be true):**
- The owner's payout account is **Active**, made with the same Razorpay keys (test or live).
- The property is set to **Online + cash**.
- The tenant owes something.

## What changed: hostelnode.com (tenants)

**My PG** (`/student/my-pg`) appears in the student menu for anyone whose HostelNode login mobile number matches a tenant mobile number an owner entered.
- A student with no match never sees it.
- Logging in is the existing OTP login, so the number is proven.

The page shows:
- **The PG:** room, bed, floor, rent and due day.
- **Due now:** by month, with **Pay ₹X** and **Pay a different amount** (₹100 up to the due; it pays the oldest month first).
- **Months:** the same figures the owner sees.
- **Receipts:** a PDF for every payment, cash ones included.
- **Deposit held.**
- **Leaving?:** give notice with a date and reason.

**Pay rent** shows "Paying Sai PG Nerul through HostelNode", what the money is for, the fee (when the tenant pays it), and the total. Then Razorpay checkout opens (UPI, card, netbanking).

**After paying** the tenant sees:
- The amount, receipt number, Razorpay id, what it paid for, and what is still due.
- **Download receipt**, and the receipt on WhatsApp if the template is set.

If the payment is still being confirmed, the page updates by itself.

**A tenant whose PG can't take online rent** sees a plain message instead: the owner isn't set up yet, or the property is cash only.

## What changed: owner dashboard

- **Ledger:** "₹8,700 paid · **Paid online by tenant** · UPI", with the receipt number and Razorpay id. It appears the moment Razorpay confirms the payment.
  - Online payments can't be cancelled by the owner; refunds go through HostelNode.
  - Payments → Collected says "paid online by tenant".
- **Tenant page:**
  - **The tenant's notice request** shows with **Accept notice**, which sets the leaving date exactly as Phase 3's "Give notice", or **Decline**. The tenant sees the answer in My PG.
  - If the owner gives notice themselves while a request waits, their date stands.
  - **Invite to pay online** (or "Send the My PG link" if the tenant already has an account) opens the owner's own WhatsApp with the link and how to log in.
- **Receive payments → Bank account:** when Active, a switch per property: **Online + cash** or **Cash only**.
- **Receive payments → Payouts:** each online payment, the fees, the amount to the bank, and its status: **On the way**, **In your bank (date)**, **On hold**, **Delayed** (HostelNode is checking) or **Returned**. A refunded payment stays listed, marked "Refunded to the tenant".

## What changed: your admin (hostelnode.com/admin → Payouts → an owner)

- **Online rent (paid by tenants):** each payment with what the tenant paid, what goes to the owner, the transfer id and its status.
  - **Check with Razorpay** refreshes the statuses.
  - **Send again** appears when Razorpay says a transfer failed (for example low balance).
- **Hold payouts / Release payouts** now also hold or release, at Razorpay, the owner's online rent that has not reached their bank yet. The result is written in the owner's history.
- **Second payments to refund:** rare. A tenant paid the same order twice from two tabs. The second payment is never counted as rent; refund it in Razorpay → Payments.
- **Paid but not recorded:** very rare. Razorpay collected the money but the tenant record had been deleted. Refund it or record it by hand.

## How the money moves, and stays safe

- The tenant pays HostelNode's Razorpay account. The Razorpay order already carries the Route transfer to the owner's linked account, so **Razorpay makes the transfer exactly once**, when the payment is collected.
- **The owner receives:** what the tenant paid − the gateway fee − the HostelNode commission. With the fee paid by the tenant, the owner gets the full rent less any commission.
- **Every amount is worked out on the server** from the ledger and your fee settings. The browser only says how much rent to pay, and that is checked against what is due.
- **Rent is recorded only after Razorpay confirms the money was collected**, from the tenant's browser (with Razorpay's signature checked), the webhook, or the result page asking Razorpay.
- **One Razorpay payment makes one ledger entry**, however many times we hear about it and from whichever site.
- **The payment is dated** with Razorpay's payment time, so a late webhook still lands on the right day.

**Refunds:** refund in Razorpay Dashboard → Payments.
- **Tick "Reverse transfers"** so the owner's share comes back too.
- A **full** refund cancels the ledger entry automatically ("Refunded to the tenant through Razorpay"), and the rent shows as due again.
- A **part** refund does not change the ledger. Add a charge or note on the tenant if needed.
- If you refund without reversing, the admin page reminds you the owner still gets that payout.

## Two things to decide (not changed)

1. **Student login security.** The existing hostelnode.com OTP is 4 digits with no limit on tries. Now that My PG shows a tenant's rent and lets them give notice, I recommend tightening it:
   - 6 digits.
   - At most 5 tries per code.
   - A short wait between codes.

   I did not change the login because it is outside this phase; say the word and I'll do it.
2. **Gateway fee level.** Razorpay charges about 2% + 18% GST, plus a small Route fee. With the default "2%" and 0 commission, HostelNode pays a little on each payment. Consider 2.4–2.5% in Fees & commission.

## Test list for UAT (with Razorpay test keys)

1. In Receive payments, an owner with an **Active** test payout account sees the property switches. Leave one property on Online + cash.
2. On that owner's tenant page, open **Invite to pay online**: WhatsApp opens with the My PG link.
3. On hostelnode.com, log in (OTP) with that tenant's mobile number. **My PG** is in the menu, showing due now, months, receipts and the deposit.
4. **Pay a different amount:** ₹50 is refused; ₹1,000 shows the fee and total.
5. Pay the full due with Razorpay's test UPI or card. The paid page shows the receipt, and the PDF downloads.
6. In the owner dashboard, within seconds the ledger shows **Paid online by tenant** with the Razorpay id, and Payouts shows it **On the way**.
7. In the Razorpay test dashboard → Route → Transfers there is **one** transfer to the owner's account for that payment.
8. Close the browser right after paying on a second payment: it still appears (webhook).
9. Switch the property to **Cash only**: the tenant no longer sees Pay. Switch it back.
10. Admin → Payouts → the owner: **Hold payouts**, then pay again: the transfer is on hold at Razorpay. **Release**: it goes on.
11. In My PG, **Give notice to leave**. The owner sees the request with Accept/Decline. Accept sets the leaving date; the tenant sees "confirmed".
12. On a phone: My PG, Pay rent, the paid page and the notice form fit the screen.

## Tests run before delivery

- **New Phase 7 tests: 150 checks, all passing**, against a Razorpay stand-in. They cover:
  - My PG for tenants, non-tenants and logged-out visitors, and the menu link.
  - Matching numbers typed as "+91 …".
  - Not available: no payout account, cash-only property, keys from the other mode, suspended account, keys missing.
  - The pay page, fee and total, and partial amounts.
  - Refused amounts and other students' stays.
  - Order reuse, and the Route transfer in the order.
  - Signature checks: a bad signature, and another student confirming.
  - One entry from browser + webhooks at the same moment.
  - The webhook-only path, authorized-only payments, and the result page asking Razorpay.
  - Razorpay unreachable: nothing recorded on the signature alone.
  - A second payment on a paid order, a failed payment, and a full refund.
  - An old webhook for a payment refunded since, and late webhooks dated correctly.
  - Receipts (tenant and owner), the owner's ledger, Collected and Payouts.
  - Transfer and settlement updates.
  - Commission override; hold and release at Razorpay; a failed transfer and **Send again** (once only).
  - The per-property switch, and another owner unable to change it.
  - Invite links.
  - The notice request: send, decline, accept, take back, a date that has passed, and the owner's own notice.
  - Messages that come only from fixed codes; blocked student accounts.
  - The WhatsApp receipt, and the shared files being identical.
- **Earlier suites rerun, all passing:**

  | Suite | Checks |
  |---|---|
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
  - Never recording a payment Razorpay hadn't collected.
  - Second payments on the same order.
  - Refunds.
  - Hold settings reapplied by the 30-minute check.
  - A safer **Send again**.
  - Payment dates.
  - Webhook retries only for temporary problems.
  - Fixed-code messages.
- **Known and not changed:**
  - hostelnode.com /admin and /admin/hostels return an error, as they do on GitHub now.
  - The admin panel scrolls sideways on phones, as before.
