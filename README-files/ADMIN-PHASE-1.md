# HostelNode Admin Console — Phase 1: Foundation and tracking

There are three ZIPs:

| ZIP | What it is | Built on |
|---|---|---|
| `hostelnode-admin-phase1.zip` | The whole new project for **admin.hostelnode.com** (new repo `hostelnode-admin`) | — |
| `HostelNode-Admin-Phase1-MainSite.zip` | Changed files only for **hostelnode.com** | GitHub `e58e41f` |
| `HostelNode-Admin-Phase1-OwnerDashboard.zip` | Changed files only for **manage.hostelnode.com** | GitHub `a32f6be` |

Both app ZIPs keep your own `.env` path lines in `app.js`. Nothing that owners, students or tenants see changes, except one optional "Share your location?" card (it can be switched off in the admin).

---

## 1. Before you install (one time)

1. **DNS.** Add an `A` record `admin` → `88.222.242.183`.
2. **New secrets.** Run each of these on the server once and keep the results; you'll paste them below:
   ```
   openssl rand -hex 32     # → ADMIN_SESSION_SECRET (admin only)
   openssl rand -hex 32     # → HN_PII_KEY (the SAME value in all three .env files)
   ```
3. **Gmail app password — required.** The old password was written in `utils/sendMail.js`, so it is on GitHub.
   - In Google: Account → Security → App passwords. **Delete the old one** and create a new one.
   - Put it in **both** apps' `.env` as `MAIL_USER` and `MAIL_PASS` (see the tables below).
   - **If `MAIL_USER` / `MAIL_PASS` are missing, no email goes out:** OTP emails, password resets, receipts, reminders. The app prints `❌ MAIL_USER / MAIL_PASS are not set` at start-up.
4. **Back up the database** (`mongodump`).

## 2. `.env` lines

### hostelnode.com (`/root/hostelnode-envs/hostelnode.com/.env`) and manage.hostelnode.com (`/root/hostelnode-envs/manage.hostelnode.com/.env`)

Add these to **both** files:

| Name | Value | Needed? |
|---|---|---|
| `MAIL_USER` | `hostelnodehelp@gmail.com` | **Required** (moved out of the code) |
| `MAIL_PASS` | the new Gmail app password | **Required** |
| `HN_PII_KEY` | the value from step 2 (same in all three files) | **Required** for matching messages to a person |
| `HN_INTERNAL_IPS` | your office/home IPs, comma-separated | Optional (can also be set in the admin) |
| `WA_APP_SECRET` | Meta → your app → Settings → Basic → App secret | Recommended: then only Meta can post delivery receipts |
| `HN_TRUST_CF` | `on` only if the site is behind Cloudflare | Optional |
| `HN_TRACKING` | `off` stops all tracking on that site | Optional (default on) |

### admin.hostelnode.com (`/root/hostelnode-envs/admin.hostelnode.com/.env`)

A full template is in `.env.example` in the admin ZIP.

| Name | Value |
|---|---|
| `PORT` | `6080` |
| `MONGO_URL` | the same database as the apps |
| `ADMIN_SESSION_SECRET` | from step 2 |
| `HN_PII_KEY` | the same value as in the two apps |
| `ADMIN_BASE_URL` | `https://admin.hostelnode.com` |
| `ADMIN_SESSION_HOURS` / `ADMIN_IDLE_MINUTES` | `24` / `120` |
| `ADMIN_IP_ALLOWLIST` | optional: only these IPs can open the console |
| `HN_MAIN_SITE_URL` / `HN_OWNER_DASHBOARD_URL` | `https://hostelnode.com` / `https://manage.hostelnode.com` |
| `WA_TOKEN`, `WA_PHONE_ID` | same as the apps |
| `WA_TEMPLATE_ADMIN_OTP` | `hostelnode_otp` (your approved OTP template) |
| `MAIL_USER`, `MAIL_PASS` | same as the apps |
| `HN_TIMEZONE` | `Asia/Kolkata` |

The console refuses to start if `MONGO_URL`, `ADMIN_SESSION_SECRET` or `HN_PII_KEY` is missing, and says which one.

## 3. Install

1. **Admin console**
   ```
   # create the GitHub repo hostelnode-admin, push the ZIP contents, then on the server:
   cd /root && git clone https://github.com/ketanmahajan24/hostelnode-admin.git && cd hostelnode-admin
   npm install
   nano /root/hostelnode-envs/admin.hostelnode.com/.env      # the table above
   node scripts/setup.js        # roles, indexes, and asks for the first Super admin (name, email, WhatsApp number, password)
   pm2 start ecosystem.config.js && pm2 save
   cp deploy/admin.hostelnode.com.conf /etc/nginx/sites-available/admin.hostelnode.com
   ln -s /etc/nginx/sites-available/admin.hostelnode.com /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d admin.hostelnode.com
   ```
2. **hostelnode.com:** unzip over the repo, add the `.env` lines, restart.
3. **manage.hostelnode.com:** unzip over the repo, add the `.env` lines, restart.
4. Open **https://admin.hostelnode.com** and sign in. You'll get a WhatsApp code and an email code.

**Check once:** your existing nginx for both sites should pass the visitor's address with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (the usual setting). The city of each visitor comes from it.

**Meta webhook:** in Meta → WhatsApp → Configuration, the webhook URL stays as it is (`…/webhook`). Make sure the **messages** field is ticked; it carries both incoming messages and delivery receipts (sent / delivered / read / failed).

No packages to install in the two apps; nothing to convert. These collections create themselves:
`hn_activity`, `hn_presence`, `hn_wa_messages`, `hn_email_log`, `hn_settings`, `admin_users`, `admin_roles`, `admin_sessions`, `admin_otps`, `admin_audit`.

## 4. What the admin console does (Phase 1)

**Sign-in**
- Email and password, then **both** a 6-digit WhatsApp code and a 6-digit email code.
- Passwords: 12+ characters with upper and lower case, a number and a symbol. Your name, email and common passwords are refused. New passwords are also checked against known data leaks (only 5 characters of a hash leave the server).
- Codes last 5 minutes, allow 5 tries, and are stored only as hashes. The email code is never in the subject line.
- 5 wrong passwords or codes lock the account for 15 minutes. The admin gets an email.
- A sign-in from a new device or city sends an email alert.
- **Forgot password** needs both codes. A reset signs out every session.

**Sessions**
- A session ends 24 hours after sign-in (never extended), or after 2 hours with no activity.
- A session can be signed out from **My account** or **Team & roles**. The cookie works only on admin.hostelnode.com: HTTPS only, not readable by scripts, strict same-site.

**Team & roles**
- **Invite an admin:** an email link (72 hours) to set a password, then they confirm a WhatsApp code and an email code.
- **Six starting roles:** Super admin, Finance, Support, Sales/Growth, Moderator, Analyst. You can make your own roles by ticking permissions.
- **Least privilege:**
  - Nobody can give a permission they don't have.
  - Only a Super admin can give the Super admin role or Team & roles.
  - You can't change your own role or disable yourself.
  - There is always at least one active Super admin.
- **Masked details:** phone, email and Aadhaar are masked everywhere. **Reveal** needs its own permission, and each reveal is saved in the audit log first.

**Audit log**
- Every sign-in, refusal, reveal, record opened, phone/email look-up, switch change and team change.
- Filter by admin, area, date and text. CSV export needs the Export permission and is itself logged.
- The console has no way to edit or delete audit rows.

**Overview** (live, refreshed every 5 seconds)
- **Online now:** owners, students and visitors seen in the last 2 minutes.
- **Today against this time yesterday:** sign-ups, searches, enquiries, money in online (rent, plans, bookings), and WhatsApp delivered and failed.
- **Traffic:** unique visitors per hour, today against yesterday.
- **Live activity feed:** sign-ins, owner actions, searches, payments, WhatsApp failures.
- **Other cards:** cities students search, WhatsApp by kind, and today's totals.
- **Filter:** both sites, or one site.
- **By role:** money cards and payments in the feed need the money permission; WhatsApp needs the WhatsApp permission; names need the people permission.

**Search (Ctrl K)**
- Finds owners, students, tenants, properties, listings, bookings (BK-…) and receipts.
- Phone numbers match only on the whole 10-digit number, and emails only on the whole address, so a search can't be used to guess a hidden number.

**Owner, student and tenant card** (Phase 2 grows it into the full 360 view)
- **Details:** masked phone, email and Aadhaar, with Reveal.
- **Owners:** plan, KYC, properties, tenants and listings.
- **Students:** searches and bookings.
- **Everyone:** the WhatsApp messages to their number and their recent activity with city and device.

**Settings**
- **WhatsApp switches:** everything, each kind (rent, bookings, leads, flatmate, …) and each template. Sign-in codes can never be switched off.
- **Feature switches:** online booking, online rent, payouts, rent ledger, Reports, rent reminders, reminder emails. Each can be "As .env", On or Off, and each site's `.env` value is shown next to it. Both sites follow a change within 30 seconds.
- **Tracking:** on/off, the location card on/off, internal IPs, and test accounts (left out of the numbers).

## 5. What the two apps now record

| What | Where | Notes |
|---|---|---|
| Page opened | both | who (or an anonymous visitor id), page, city from IP, device, referrer; a reload within 10 s counts once |
| Sign-in, failed sign-in, sign-out, OTP asked / refused / accepted, password reset | both | email/phone masked; "new device" flag |
| Owner actions | both | about 70 named actions (added a tenant, recorded a payment, accepted a booking, …) |
| Student actions | hostelnode.com | enquiry, contact owner, booking paid, rent paid, notice, flatmate, messages |
| Who is online | both | a light heartbeat while a page is open |
| Location | both | city from the IP always; exact GPS only after the person taps **Allow** on the card |
| Searches | hostelnode.com | all filters (budget, gender, type, room type, amenities, sort), the real total of matches, page; repeats and team searches marked |
| WhatsApp | both | every message: kind, template, masked number, Meta's message id, sent/failed, then delivered/read/failed from Meta's receipts; incoming messages to your number |
| Email | both | purpose, masked address, sent or failed |

**Rules that keep the numbers exact**
- Search engines and scripts are marked as bots and kept out.
- The HostelNode team, test accounts and office IPs are marked internal.
- Money and records always come from their own collections, never from tracking.
- Delivered and read come only from Meta's receipts.
- Times are India time.

**Never stored:** full phone numbers or emails (masked, plus a keyed hash), passwords, OTP codes, password-reset links, or message text sent by HostelNode.

**Kept for:** activity 180 days; WhatsApp and email logs 365 days.

**Location card**
- Students see it once, 4 seconds after a page opens: "Share your location? HostelNode uses it to see which areas students look for PGs in…". Owners see it on their dashboard.
- **"Not now"** waits 30 days. Nothing is read without **Allow**, even if the browser already allows location for the site.

## 6. Security fixes in your current apps

- **hostelnode.com `PUT /dashboard/:id`** changed any owner's status without signing in. It now needs a signed-in admin.
- **Old admin login (`/loginforadmin`, `POST /admin-login`)** compared plain-text passwords and showed the user list without a session. Both now go to `/admin/login`.
- **OTP in the server log:** every login OTP was printed (`models/Whatsapp.js`). Now only the phone number is printed.
- **Gmail password:** it was written in `utils/sendMail.js` and `routes/userRoutes.js` (both apps), and in `routes/userRoutes-backup.js` (main site). It is now in `.env` only. **Create a new app password, as in step 3 of section 1.**
- **One mailer:** every email now goes through `utils/sendMail.js`, including plan reminders, receipts and account emails.
- **One WhatsApp sender:** every WhatsApp message now goes through `utils/waSend.js`, with the same templates and words as before.

## 7. Files changed

**New in both apps (identical):**
- `utils/activity.js`, `utils/waSend.js`, `utils/hnPii.js`, `utils/hnSettings.js`, `utils/hnFeatures.js`
- `models/hnActivity.js`, `hnPresence.js`, `hnWaMessage.js`, `hnEmailLog.js`, `hnSettings.js`

**Changed in both apps:**
- `app.js`: mounts tracking, starts the feature switches, keeps the webhook's raw bytes for Meta's signature. Your `.env` path line is kept.
- `app-wa-bot.js`: receipts and incoming messages are logged; bot replies go through `waSend`.
- `models/Whatsapp.js`, `utils/leadWhatsapp.js`, `utils/bookings.js`, `utils/tenants.js`, `utils/planReceiptWhatsapp.js`: send through `waSend`.
- `utils/sendMail.js`: one mailer with `.env` credentials and the email log.
- `routes/userRoutes.js`: its own mailer, with the hard-coded password, is replaced by `utils/sendMail.js`.

**Owner dashboard only:** `utils/rentReminders.js`, `utils/planReminders.js`, `routes/checkoutRoutes.js`, `routes/accountRoutes.js` (email and WhatsApp through the shared senders).

**Main site only:**
- `routes/findHostels-route.js` and `utils/searchLogger.js`: search filters and the real total.
- `models/searchLog.js`: new fields.
- `routes/userRoutes-backup.js`: the password is removed.

## 8. Good to know

- **No history before install day.** Activity, online people, logins and WhatsApp receipts start then. Money, bookings and sign-ups go back to the beginning.
- **First day:** existing visitors get a new visitor id on their first page, so "unique visitors" runs a little high for about a day. Each person's first sign-in after install is marked "new device".
- **IP city is approximate,** especially on mobile data. It uses the free copy built into the server. Optional, more current data: `npm install maxmind` in an app, download GeoLite2-City, and set `GEOIP_DB_PATH`.
- **The old `/admin` on hostelnode.com still works as before.** Phase 3 moves it into this console and redirects it.
- **Locking an account:** anyone who knows an admin's email can lock it for 15 minutes with 5 wrong passwords, which is the price of the lockout. `ADMIN_IP_ALLOWLIST` stops this completely.

## 9. Privacy paragraph for your Privacy Policy

> **Activity and location.** To run and protect HostelNode, we record how our websites are used: pages opened, sign-ins, actions taken in your account, searches, and the city we estimate from your internet (IP) address. If you choose "Allow" when we ask, we also record your device's location while a HostelNode page is open; you can say "Not now" or turn location off in your browser at any time. Messages we send you on WhatsApp and by email are logged with their delivery status. Phone numbers and email addresses are kept in these logs only in masked form. Activity records are kept for 180 days and message logs for 365 days, and are seen only by authorised HostelNode staff. You can ask us to access or correct your data, or withdraw consent, by writing to hostelnodehelp@gmail.com.

This is a suggested text under India's Digital Personal Data Protection Act, 2023, not legal advice.

## 10. Test list for UAT

1. **Sign in.** Open admin.hostelnode.com and sign in: password, then the WhatsApp code and the email code. A wrong code is refused, with the tries left.
2. **Invite.** Invite a second person as Support. The email link sets a password and asks for both codes. As Support: Team & roles, Audit log and Settings say "Not allowed"; phone numbers are masked, with no Reveal.
3. **Reveal.** As Super admin, open an owner from search (Ctrl K, type their full number) and press Reveal on the phone. The Audit log shows "Revealed phone of owner".
4. **Live.** On your phone, sign in to manage.hostelnode.com. Within 5 seconds the Overview feed shows it, and Online now goes up. Record a payment: "recorded a payment" appears.
5. **Search.** On hostelnode.com, search "PG in Pune" with a budget. The Overview's Searches count goes up; Pune appears in "Where students search".
6. **WhatsApp.** Send yourself an OTP from the student login. Settings → WhatsApp → Sign-in codes shows "today 1 sent". After it arrives, the Overview shows it delivered (if `WA_APP_SECRET` is set, only signed receipts count).
7. **A switch.** Switch "Rent" off, press Send reminder on Dues: no WhatsApp goes, and the person card shows the message as "off". Switch it back on.
8. **A feature.** Set Reports to Off: within 30 seconds the owner dashboard shows the old Reports page. Set it back to "As .env".
9. **Sessions.** In My account, sign out your other session. Sign in on two devices; from Team & roles, Sign out sessions ends the other one.
10. **Phone.** Open the console on a phone: menu, Overview, Team & roles and Settings, with no sideways scrolling.

## 11. Tests run before delivery

**New tests, all passing:**
- **Admin console:** 136 checks.
  - Sign-in with both codes; codes hashed and single-use; lockout and alert.
  - 24-hour and idle limits; invite flow; forgot password.
  - Every permission allowed and refused; no escalation by non-super admins.
  - Reveal logged; search masking and exact matching; CSRF.
  - Settings switches reaching the owner site.
  - Overview numbers recomputed independently from the records (money, sign-ups, enquiries, online now, WhatsApp failed).
  - Live feed and stream; the feed hiding money and names by role.
  - Audit export with formula-safe CSV; sign-out; crash-safe odd inputs.
- **Tracking in both apps:** 107 checks.
  - Page views, reload once, bots, internal IPs, the tracking switch.
  - Owner sign-in, failed sign-in, new device, actions, presence.
  - Student OTP with masked numbers.
  - WhatsApp log, Meta's error, receipts (never backwards), incoming messages, signature check.
  - WhatsApp switches (OTP locked on); email log.
  - GPS saved only after Allow (rounded), refused bad positions, rate limits.
  - Reset tokens never stored; search filters, real totals and repeats.
  - The security fixes; shared files identical in both apps.

**Earlier suites, all rerun and passing:**

| Suite | Checks |
|---|---|
| Phase 9 | 119 |
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
| Owner page smoke test | 29 pages |
| Main-site smoke test | 12 of 14 pages; `/admin` and `/admin/hostels` give an error, as on GitHub now |

One test was adjusted, not the app: the billing test read only the first cookie of a response, and the new visitor cookie now comes first.

**Independent code review: three rounds.** Everything found was fixed and tested again:
- **Admin console:**
  - A crash on odd query values.
  - Search could be used to work out masked numbers.
  - The feed showed money and names to roles without those permissions.
  - The email code was in the subject line.
- **Tracking:**
  - Password-reset links were stored in the activity log.
  - Plain hashes of phone numbers could be reversed (now keyed).
  - GPS could be read before the person tapped Allow.
  - Heartbeats from made-up visitor ids could inflate "online now".
  - Slow requests were missed by the live feed.
  - Searches were counted again on the next page.
  - The search page waited on a settings read.
