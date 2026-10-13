# Property Operations — Phase 4: Aadhaar KYC with DigiLocker

There are two ZIPs, one for each site. Both were built on what is on GitHub now:
- Owner dashboard: commit e465e7e (your Phase 1 install).
- Main site: commit b55bc57.

**Both ZIPs include Phases 2, 3 and 4.** If Phase 2 and 3 aren't installed yet, installing these installs them too. Follow PROPERTY-OPERATIONS-PHASE-2.md and PROPERTY-OPERATIONS-PHASE-3.md as well (the bed recount and the WhatsApp templates still apply).

**KYC stays switched off until you add the Cashfree keys.** Without them, every page works as in Phase 3:
- The KYC badges read "Not verified".
- Admission isn't blocked.

## Install (do it in this order)

1. **Back up the database** (mongodump, or an Atlas snapshot).
2. **Owner dashboard (manage.hostelnode.com).**
   - Unzip over the repo, keeping the same folders.
   - Stop the running app completely, then start the new one.
3. **Main site (hostelnode.com).** Unzip over the repo, then restart.
4. **If Phase 2/3 are new to the server:** run the bed recount from the Phase 2 notes (`node scripts/recount-beds.js`, then `--apply`).

Nothing in the database needs converting. Four new collections create themselves:

| Collection | What it holds |
|---|---|
| `kycrecords` | One per mobile number |
| `kycsessions` | One per DigiLocker attempt |
| `kycsettings` | The two admin switches |
| `hn_locks` | Short-lived locks (already used since Phase 3) |

## Switching it on (Cashfree Secure ID: DigiLocker)

1. **Activate Secure ID → DigiLocker** in the Cashfree merchant dashboard. Start in **Sandbox (test)** mode.
2. **Copy the Client ID and Client Secret** for Secure ID / Verification. These are not the Payment Gateway keys.
3. **Two-factor for the API.** Choose one:
   - **Public key (recommended).** Download Cashfree's public key (a `.pem` file). Put it on both servers, outside the web folders, for example `/secure_uploads/cashfree_kyc_public.pem`.
   - **IP whitelist.** Whitelist both servers' outgoing IP addresses in Cashfree instead. Then leave the key lines out.
4. **Add the same lines to the `.env` of BOTH servers.** Type them on the server; never paste keys in chat or email.
   ```
   CASHFREE_KYC_CLIENT_ID=...
   CASHFREE_KYC_CLIENT_SECRET=...
   CASHFREE_KYC_PUBLIC_KEY_PATH=/secure_uploads/cashfree_kyc_public.pem
   HN_MAIN_SITE_URL=https://hostelnode.com
   ```
   - Owner dashboard only, if not already there: `HN_OWNER_DASHBOARD_URL=https://manage.hostelnode.com`.
   - Main site: it already has `HN_OWNER_DASHBOARD_URL` from Phase 2.
5. **Restart both apps.**
6. **Open hostelnode.com/admin/kyc** (sidebar → Verification → KYC (DigiLocker)).
   - It should say **Test mode** and "a public key is set".
   - "Students can verify" is on; "KYC required for admission" is off.
7. **Do the test list below with sandbox keys.**
8. **Go live:**
   - Swap to the production keys and public key.
   - Add `CASHFREE_KYC_ENV=production` on both servers, then restart.
   - The admin page should say **Live**.
9. **Optional:** when you're ready, turn on **KYC required for admission** on the admin page. It takes effect within 15 seconds.

If Cashfree asks for allowed return addresses, give both of these:
- `https://hostelnode.com/kyc/return`
- `https://manage.hostelnode.com/user/kyc/return`

## How it works

**The student verifies themselves.** This is the normal way.
- The owner taps **Ask to verify** on:
  - the Add tenant form,
  - the tenant page, or
  - a lead in Leads & CRM.
- The owner's own WhatsApp opens with a message and the link `hostelnode.com/kyc?p=<property>`.
- The student logs in with OTP, taps Verify with DigiLocker, and enters their Aadhaar OTP. That's done in about a minute.
- Students can also verify any time from their profile page.

**Verify on this phone.** This is for a tenant standing in front of the owner, without a smartphone. DigiLocker opens on the owner's phone and the tenant enters their own Aadhaar OTP.

**The Add tenant form updates by itself** when the tenant finishes. The form compares the name typed in with the Aadhaar name, and offers "Use the Aadhaar details".

**When "KYC required for admission" is on**, these are refused until the mobile number is KYC-verified:
- Admitting a tenant (Admit is locked, and the server refuses it too).
- Changing a living tenant's mobile.
- Undoing a move-out.

The switch has no effect while the Cashfree keys are missing, so a missing key can never stop admissions.

## What is kept, and who sees it

**Kept** (per mobile number):
- The name, date of birth, gender and state on the Aadhaar.
- The **last 4 digits** of the Aadhaar number.
- When it was verified, and Cashfree's reference number.

**Never kept:**
- The full Aadhaar number.
- The Aadhaar photo.
- The Aadhaar XML/file.

**Who can see the name, birth date and last 4 digits.** Only owners the person shared them with:
- The student verified from that owner's link. The page says "<PG> will see your verified name, date of birth and last 4 Aadhaar digits."
- The student tapped **Share with <PG>** later.
- The verification was done on that owner's phone, in person.

Every other owner sees only the badge.

**Other safeguards:**
- **Checks on an owner's phone.** These count only for that owner. Other owners see "Not verified" until the student verifies themselves, or the tenant is checked on their phone too.
- **A verified number keeps its person.**
  - A different Aadhaar can't replace it.
  - The only exception is the student, logged in by OTP. They can replace a check done on an owner's phone, or one done by an earlier holder of the number.
  - One Aadhaar can't verify a second number on an owner's phone. The exception: an owner who verified a mistyped number can verify the right number, and the wrong one is cleared.
- **The pages DigiLocker returns to never show personal details.**

**One thing to know.** KYC proves who owns the **mobile number**, not who is standing at the desk. The Add tenant form warns when the typed name differs from the Aadhaar name. Owners should still look at the person.

## Privacy policy (suggested text; please have it checked)

> **Aadhaar verification (KYC).** If you choose to verify your identity, we use DigiLocker through our verification partner Cashfree Payments. With your consent on DigiLocker, we receive and keep your name, date of birth, gender, state and the last 4 digits of your Aadhaar number, linked to your mobile number. We do not store your full Aadhaar number, your Aadhaar photo or your Aadhaar document. A PG owner can see these details only when you share them with that PG (by verifying from their link, tapping Share, or verifying on their phone in person); other PGs only see whether your number is verified. To have your verification removed, write to hostelnodehelp@gmail.com.

## Test list for UAT (sandbox keys first)

1. **/admin/kyc:** shows Test mode, the public key, and both switches.
2. **Student profile** (hostelnode.com): the "Verify your Aadhaar" card appears.
   - Verify: DigiLocker (sandbox) → back on "You're verified!".
   - The profile shows the name and xxxx xxxx 1234.
3. **Add tenant**, typing that student's mobile: "KYC verified" appears. The details show only if they verified from your link (see 4).
4. **Another student's mobile:** tap **Send KYC link on WhatsApp**. WhatsApp opens with the message.
   - Open the link on the phone and verify.
   - The Add tenant form turns green by itself within a few seconds.
5. **Verify on this phone** for a new number: DigiLocker opens.
   - After the OTP the page says "Aadhaar verified".
   - Close it; the form shows the details.
6. **Owner B** (another account), the same number as 5: "Not verified" and no details.
   - **Ask to verify**, then the student taps **Share with <B's PG>**. B now sees the details.
7. **Deny consent on DigiLocker:** "Verification not finished – sharing was not allowed". Nothing is saved.
8. **Turn on "KYC required for admission"** and wait 15 seconds:
   - Add tenant for an unverified number: step 3 is locked with the reason.
   - A verified one: Admit works.
   - Turn it off again.
9. **Tenants list:** the KYC column, the "KYC not verified" count, and its filter.
10. **Tenant page:** the KYC pill, "Ask to verify KYC", and the Aadhaar details in Person.
11. **Leads & CRM:** KYC badges, and "Ask to verify" on a lead.
12. **Phone:** the student KYC page, the Add tenant KYC box and the return pages fit the screen.

## Tests run before delivery

**New Phase 4 tests: 96 checks, all passing.** They run against a Cashfree DigiLocker stand-in that checks the keys and decrypts the signature with a test key pair. They cover:
- Student and owner flows.
- Deny, expire, and Aadhaar not in DigiLocker.
- The return pages without a login.
- Who sees what, Share, and Ask to verify.
- A number that changed hands, and a mistyped number.
- One Aadhaar on two numbers, and checks finishing at the same moment.
- The admission switch: admission, mobile change, the old edit page, and undo move-out.
- No keys means no blocking.
- Admin switches, and the photo/XML never being stored.

**Earlier suites rerun, all passing:**

| Suite | Checks |
|---|---|
| Phase 3 | 122 |
| Phase 2 | 95 |
| Phase 1 | 82 |
| Billing and plans | 106 |
| Payments | 108 |
| Listings and leads | 156 + 17 + 20 + 27 |
| Admin | 44 |
| Upgrade popup and drafts | 65 |
| Page smoke test | 35 pages |

**Independent code review: three rounds.** Everything found was fixed and tested again. Fixes included:
- Details leaking between owners.
- A reused number showing the old holder's details.
- Owner-phone checks counting for everyone.
- Bypassing the switch through mobile edits or undo move-out.
- Two checks saving at the same moment.
