# Property Operations — Phase 2: rooms, floors, beds, free beds on listings

Two ZIPs, one for each site. Both were built on what is on GitHub now:
owner dashboard at commit 0c08cf6, main site at commit b55bc57.

**The owner dashboard ZIP includes Phase 1.** If you have not installed Phase 1 yet, this one ZIP installs both. Read PROPERTY-OPERATIONS-PHASE-1.md too, because its notes still apply.

## Install (do it in this order)

1. **Back up the database** first (mongodump, or an Atlas snapshot).
2. **Owner dashboard (manage.hostelnode.com).**
   - Unzip over the repo, keeping the same folders. That is 34 code files (24 changed, 10 new) plus the two notes files.
   - **Stop the running app completely, then start the new one.** Don't run the old and new versions side by side, because the old midnight rent job could charge a tenant twice.
3. **Run the one-time bed setup** on the owner dashboard server. It uses MONGO_URL from .env:
   ```
   node scripts/recount-beds.js           # shows what it would change; changes nothing
   node scripts/recount-beds.js --apply   # makes the changes
   ```
   - It gives every room its beds (A, B, C…).
   - It seats each tenant in a bed, in order of joining date.
   - It fixes the room and floor counts and updates linked listings.
   - Nothing about a tenant changes except their bed letter.
   - If it lists rooms with more tenants than beds, check those names. Someone may have left without being moved out.
4. **Main site (hostelnode.com).**
   - Unzip over the repo. That is 9 files: 8 changed and 1 new.
   - Add this line to the main site's .env, then restart:
     ```
     HN_OWNER_DASHBOARD_URL=https://manage.hostelnode.com
     ```

## What changed: owner dashboard

- **Rooms & beds** (`/user/allrooms`) shows every floor, room and bed.
  - Each bed is Occupied (with the tenant's name), Free (with "Admit tenant"), or Blocked.
  - Totals and a fill bar sit at the top. Filter by floor, free beds only, AC or Non-AC.
- **Tapping a room opens its details.** From there the owner can:
  - Move a tenant to another free bed.
  - Block a bed for repair, with a reason, or unblock it.
  - Give one bed its own rent.
  - Add a bed, edit the room, or delete it (only when empty).
- **Add rooms** (`/user/newroom`) adds one room, or many at once (for example 201 to 208, or G01 to G08).
  - Choose beds per room, rent, AC or Non-AC, and what's included.
  - A live preview shows which rooms will be added and skips rooms that already exist.
- **Floors** (`/user/floors`): rename, reorder (↑ ↓), add rooms to a floor, and delete when empty.
- **Admitting a tenant**
  - The room list shows the floor, rent and free beds. Full rooms can't be picked.
  - "Admit tenant" on a free bed puts the tenant in that bed.
  - The first month is charged at that bed's rent.
- **A tenant's rent stays the same when they move.**
  - If the new bed costs more or less, they keep paying what they paid.
  - The room details show "Pays ₹X (kept from their earlier bed)", with a button to charge the bed's rent from next month instead.
- **Rent changes**
  - Changing a room's rent changes it for its tenants from the next rent day, as before.
  - Tenants who kept an older rent after a move are the only exception.
- **Free beds on your listings**
  - My Listings has a "Show free beds" button. It links a listing to a property, and each room type (Single, Double…) is matched to rooms with that many beds. You can also pick rooms by hand.
  - The free-bed numbers update by themselves when a tenant moves in or out, or a bed is blocked.
- The sidebar under Rooms & Floors now has: Rooms & beds, Floors, Add rooms.
- The old addresses (/user/managerooms, /user/managefloor, /user/newfloor) open the new pages.

## What changed: main site

- **Free beds on listings.** A linked listing shows "3 beds free" or "Full right now" on the hostel page and in search results.
  - A room type that can't be matched (for example "Deluxe") keeps showing the old "Available now" / "Waitlist".
- **The old owner pages on hostelnode.com now redirect.** Tenant, payment, report, room and floor pages under hostelnode.com/user (for example /user/members) send owners to manage.hostelnode.com.
  - Why: those copies were old and didn't check that a record belonged to the logged-in owner, so one owner could reach another owner's tenants.
  - Owners now manage everything in one place, where every page checks ownership.
  - Listing, profile, login and property pages on hostelnode.com are unchanged.
- **Shared database models.** The shared models (listing, room, floor, tenant) are identical in both apps, so neither one drops the other's new fields.

## Things to know

- Rooms with more than 20 beds can't be added. Bulk add is limited to 60 rooms at a time.
- **Lowering a room's bed count**
  - It is refused when tenants live in the beds being removed and the only beds left for them are blocked. Unblock a bed or move the tenant first.
  - A tenant from a removed bed is moved to a free bed and keeps their rent.
- Tenants with a kept rent don't get later room-rent increases until you press "Charge this bed's rent". A per-tenant rent editor comes in the rent-ledger phase.

## Test list for UAT

1. Rooms & beds opens and shows every room. The bed counts match the tenants who live there.
2. Add rooms, many at once: 201 to 205 with 2 beds each. The preview shows 5 rooms and 10 beds. Repeat it, and the existing rooms are skipped.
3. Add a room with letters, for example G01 to G03. The zeros are kept.
4. Floors: rename one, move it up, and try to delete one that has rooms (it is refused).
5. Tap a free bed and choose Admit tenant. The form has that room and bed already chosen. Save, and the tenant shows in that bed.
6. Choose a full room in the admission form. It can't be picked.
7. Block a free bed with a reason. It shows as Blocked, isn't counted as free, and the listing's free beds go down by one.
8. Give one bed its own rent (for example ₹7,500). A tenant admitted into it is charged ₹7,500.
9. Move a tenant to a bed with a different rent. The details show "Pays ₹(old rent)". Press "Charge this bed's rent", and the line goes away.
10. Edit a room: change its number and floor. Its tenants show the new room number.
11. Lower a room's beds below the number of tenants. It is refused.
12. Delete an empty room (allowed), then a room with a tenant (refused).
13. My Listings: open Show free beds, link the listing to your property, and save. The listing shows "N beds free".
14. Admit a tenant, then move one out. The free beds on hostelnode.com change by one each time.
15. Edit the listing (change a price). The free beds stay linked.
16. On hostelnode.com, open /user/members while logged in. You land on manage.hostelnode.com/user/members.
17. On hostelnode.com, check that My Listings, edit listing, profile and login all still work.
18. Phone: Rooms & beds, room details, Add rooms and Floors all fit the screen without sideways scrolling.

## Tests run before delivery

- New Phase 2 tests: 95 checks, all passing. They cover owner isolation (another owner's rooms, floors, beds, tenants and listings can't be reached), every action above, and the main-site redirect.
- Earlier suites rerun, all passing:
  - Phase 1: 79 checks.
  - Billing and plans: 106 checks.
  - Payments: 108 checks.
  - Listings and leads: 155 + 17 + 20 + 27 checks.
  - Admin: 44 checks.
  - Upgrade popup: 65 checks.
  - Page smoke test: 25 pages.
- Two independent code reviews. Everything they found was fixed and covered by the tests above.
