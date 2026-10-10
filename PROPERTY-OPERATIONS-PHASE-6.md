# Property Operations — Phase 6: owner bank payouts (Razorpay Route)

There are two ZIPs, one for each site. Both were built on what is on GitHub now:
- Owner dashboard: commit e465e7e (your Phase 1 install).
- Main site: commit b55bc57.

**Both ZIPs include Phases 2–6.** If the earlier phases aren't installed yet, installing these installs them too, and their notes still apply (PROPERTY-OPERATIONS-PHASE-2.md to -5.md).

In this phase, owners register the bank account where online rent will land, and you set the fees and commission. **Tenants start paying online in Phase 7.** Until then, nothing here moves any money.

## Install (do it in this order)

1. **Back up the database** (mongodump, or an Atlas snapshot).
2. **Owner dashboard (manage.hostelnode.com).**
   - Unzip over the repo, keeping the same folders.
   - Stop the running app completely, then start the new one.
3. **Main site (hostelnode.com).** Unzip over the repo, then restart.

Nothing in the database needs converting. Two new collections create themselves:
- `payoutaccounts`: one per owner who starts.
- `payoutsettings`: your fees and commission.

**Shared files.** `models/payoutAccount.js` and `models/payoutSettings.js` are identical in both repos; keep them the same.

## Switching it on

1. **Ask Razorpay to activate Route** on your account (Dashboard → Payment products → Route), and confirm that collecting rent for PG owners is an allowed use. Test mode is enough to try everything.
2. **The owner dashboard already has the Razorpay keys** from plan payments (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`). Nothing new is needed. With test keys, the page says "Test mode".
3. **Add the payout events to the webhook.**
   - In Razorpay Dashboard → Webhooks, edit the same HostelNode webhook you made for plan payments: `https://manage.hostelnode.com/payments/razorpay/webhook`.
   - Also tick the **Account** and **Product (Route)** events (their names start with `account.` and `product.`).
   - The page also checks with Razorpay by itself: when an owner opens it, and every 3 hours for accounts still under review. So nothing is missed if a webhook is.
4. **Optional:** Razorpay asks for a business category for each owner. HostelNode sends **housing / space_rental**. If Razorpay asks for a different one, set it in the owner dashboard `.env` and restart:
   ```
   HN_ROUTE_CATEGORY=housing
   HN_ROUTE_SUBCATEGORY=space_rental
   ```
5. **Set your fees** at hostelnode.com/admin → Payouts → Fees & commission. The defaults are commission 0%, and a 2% gateway fee paid by the owner.

**Off switch:** `HN_PAYOUTS=off` in the owner dashboard `.env` hides "Receive payments". Nothing saved is lost.

**From test to live keys:** accounts made with test keys aren't used with live keys. Those owners see "Please fill in your details again" and submit once more, and Razorpay makes their real account.

## What changed: owner dashboard

**Account menu → Receive payments** (`/user/account/payouts`)

The form:
- **Who is being paid:** business type (Individual, Proprietor, Partnership, Company or LLP), legal name, PAN, and the contact person. The PAN is checked against the type: personal (4th letter P), firm or LLP (F), company (C).
- **Bank account:** account number, typed twice; IFSC, with the bank and branch shown at once; and the account holder name.
- **Contact and address:** email, mobile, address, city, state, PIN.
- **Razorpay terms:** a tick box.

It also shows a "How online rent reaches you" box and the fees that will apply.

Once submitted, a status card shows one of these:

| Status | What the owner sees |
|---|---|
| **Under review** | "Check status now" |
| **Active** | The bank as "HDFC Bank ••4521 · HDFC0000317", and **Change bank account** (Razorpay checks the new account again) |
| **Needs attention** | Razorpay's reason in plain words (for example "The account holder's name could not be matched"), and **Fix details** |
| **On hold by HostelNode** | Your reason |
| **Suspended** | Online rent is switched off |

- Once Razorpay has the account, the email and business type can't be changed; the page says to contact support.
- **Payouts tab:** each online payment with the gateway fee, commission, the amount to the bank, and when it arrived. It is empty until Phase 7.
- **Online rent stays off** for an owner until their account is Active. Phase 7 checks this.

**Privacy:** the full bank account number and PAN go straight to Razorpay. HostelNode keeps only:
- the last 4 digits of the account and of the PAN,
- the IFSC, bank and branch,
- the names, contact details and address.

Razorpay's error messages are stored with account numbers, PAN and emails hidden.

## What changed: your admin (hostelnode.com/admin)

New sidebar section **Payouts**:

**Owner payouts**
- Counts: Active, Under review, Needs attention, On hold.
- Filters: All, Needs attention, Under review, Active, On hold, Suspended, Not finished.
- One row per owner: bank ••last 4, status, commission, payouts flowing or on hold.

**Fees & commission**
- HostelNode commission: a percentage (0–30%) or a fixed ₹ per payment; 0 is allowed.
- Payment gateway fee: a percentage (0–10%) or a fixed ₹, paid by the tenant (added to what they pay) or by the owner (taken from the payout).
- A worked example for ₹6,500 rent.

**One owner's page**
- Status, details, Razorpay's reasons and the full history.
- **Commission for this owner:** the default, or their own rate.
- **Hold payouts**, with a reason the owner sees, and **Release payouts**. Online rent will still be received but held before it reaches their bank; this takes effect from Phase 7.
- **Link an existing Razorpay account:** only for the rare case where Razorpay made an owner's account but the answer never reached HostelNode (a lost connection). The owner then sees "Razorpay already has a payout account for these details". To fix it:
  1. Copy the account id from Razorpay Dashboard → Route → Accounts.
  2. Link it on the owner's page.
  3. Ask the owner to submit their details again. HostelNode checks with Razorpay that the account really is that owner's before using it.

## Test list for UAT (with Razorpay test keys)
1. Account menu → Receive payments shows the form, with "Test mode".
2. Type IFSC HDFC0000317: "HDFC Bank · …" appears. A made-up IFSC says it wasn't found.
3. Submit with a wrong PAN type (Company with a personal PAN): it's refused with the reason. Then submit correctly: "Sent to Razorpay", and the status is **Under review**.
4. In the Razorpay test dashboard (Route → Accounts), the new linked account appears with the owner's details.
5. When Razorpay activates it (in test mode this may happen by itself; otherwise use their test tools): the page shows **Active**, by webhook or "Check status now".
6. Change bank account: the new account is sent and the status goes back to Under review.
7. Admin → Payouts → Owner payouts: the owner is listed. Filters work.
8. Fees & commission: set 1% and ₹10 paid by the tenant, and save. The owner's page shows the new fees.
9. Owner's page in admin: give them their own commission; hold payouts with a reason. The owner sees the hold and reason. Release it.
10. On a phone: the form, the status cards and the Payouts tab fit the screen.

## Tests run before delivery
- **New Phase 6 tests: 101 checks, all passing**, against a Razorpay stand-in. They cover:
  - The form and its checks (PAN type, bank number typed twice, IFSC, mobile, PIN).
  - The 4 Razorpay steps.
  - That nothing sensitive is stored.
  - A failed step and a retry that carries on without a second Razorpay account.
  - A stakeholder whose answer was lost.
  - The webhook (signature, status fetched from Razorpay, plan payments unaffected).
  - Under review, Active, Needs attention, Fix details, bank change, suspended, and the 3-hourly check.
  - Test vs live keys.
  - Another owner unable to see anything.
  - Admin fees, an owner's own commission, hold and release, and linking ids, including refusing an id that isn't the owner's.
  - Non-admins refused.
  - The off switch and missing keys.
- **Earlier suites rerun, all passing:**

  | Suite | Checks |
  |---|---|
  | Phase 5 | 121 |
  | Phase 4 | 96 |
  | Phase 3 | 123 |
  | Phase 2 | 95 |
  | Phase 1 | 82 |
  | Billing and plans | 106 + 167 |
  | Payments | 108 |
  | Listings and leads | 17 + 20 + 27 |
  | Admin | 44 |
  | Upgrade popup | 65 |
  | Page smoke test | 37 pages |
- **Independent code review: three rounds.** Everything found was fixed and tested again. Fixes included:
  - Retries that could make a second Razorpay account.
  - Test-mode accounts still showing as Active with live keys.
  - The webhook answering Razorpay at once.
  - Status checks never overwriting a change being saved.
  - Razorpay messages stored with sensitive numbers hidden.
  - The email and business type locked once Razorpay has them.
- **Known and not changed:** the hostelnode.com admin panel scrolls sideways on phones on every page, as it did before.
