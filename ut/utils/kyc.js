/* ============================================================
   utils/kyc.js  —  Property Operations Phase 4 (DigiLocker KYC)
   SHARED: identical in the owner dashboard and hostelnode.com.

   • start()  — make a DigiLocker link for a mobile number (by the student
                on hostelnode.com, or on the owner's phone for a tenant
                standing in front of them).
   • finish() — after DigiLocker: ask Cashfree how it went and, when the
                person allowed sharing, save the verified details.
                Safe to call more than once.
   • catchUp() — finish an attempt whose return page was never opened.
   • share()  — the person agrees to show their verified details to a PG.
   • badgeOf(), recordsFor(), settings() — for the pages.

   Privacy rules:
   • Kept: verified name, date of birth, gender, state, last 4 digits.
     Never: the full Aadhaar number, the photo, the Aadhaar file.
   • An owner sees the name / birth date / last 4 only if the person shared
     them with that owner (sharedWith). Everyone else sees only the badge.
   • A verified number is never taken over by a different person's Aadhaar,
     except by the student themselves (their mobile is proven by OTP), and
     then only to replace a verification made on an owner's phone or by
     another HostelNode account (a number that changed hands).
   • A check done on an owner's phone counts only for that owner. Other
     owners see "Not verified" until the person verifies themselves (or
     verifies on their phone too).
============================================================ */
const crypto = require("crypto");
const moment = require("moment-timezone");
const cf = require("./cashfreeKyc");
const KycRecord = require("../models/kycRecord");
const KycSession = require("../models/kycSession");
const KycSettings = require("../models/kycSettings");
const { withLocks } = require("./locks");

const TZ = "Asia/Kolkata";
const PENDING_DAYS = 7;

/** A 10-digit Indian mobile number, or "". */
function phoneOf(v) {
  let d = String(v || "").replace(/\D/g, "").replace(/^00/, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(-10);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

// The admin switches (hostelnode.com/admin/kyc), read at most every 15 seconds.
// If they cannot be read, the last known value is used; with none known yet,
// KYC counts as required (an error never quietly opens admission).
let cache = { at: 0, value: null };
async function settings() {
  if (cache.value && Date.now() - cache.at < 15000) return cache.value;
  let s = null, failed = false;
  try { s = await KycSettings.findOne({ key: "main" }).lean(); } catch (e) { failed = true; console.error("KYC settings (non-fatal):", e.message); }
  if (failed && cache.value) return cache.value;
  const value = {
    studentsCanVerify: s ? s.studentsCanVerify !== false : true,
    requiredForAdmission: failed ? true : !!(s && s.requiredForAdmission),
    ready: cf.configured(),
    mode: cf.mode(),
  };
  // Admission is only ever blocked when DigiLocker actually works (keys set).
  value.enforced = value.requiredForAdmission && value.ready;
  value.canVerify = value.ready && value.studentsCanVerify;
  if (!failed) cache = { at: Date.now(), value };
  return value;
}
const forgetSettings = () => { cache = { at: 0, value: null }; };

const recent = d => d && Date.now() - new Date(d) < PENDING_DAYS * 864e5;
/** Pending for this viewer: an owner sees "pending" only for people they asked (or are verifying in person). */
const isPendingFor = (r, ownerId) => !!r && r.status !== "verified" && (
  ownerId
    ? (r.requests || []).some(x => String(x.owner) === String(ownerId) && recent(x.at))
    : r.status === "pending" && recent(r.pendingSince));

/** Has this person shared their verified details with this owner? */
const sharedWith = (r, ownerId) => !!(r && r.status === "verified" && ownerId && (r.sharedWith || []).some(x => String(x.owner) === String(ownerId)));
/**
 * Verified, as far as this owner is concerned: verified by the person themselves on hostelnode.com
 * (mobile proven by OTP), or on this owner's own phone. A check done on another owner's phone does
 * not count for everyone else.
 */
const verifiedFor = (r, ownerId) => !!(r && r.status === "verified" && (r.via === "student" || (ownerId && r.via === "owner" && sharedWith(r, ownerId))));

/** { key: verified | pending | none, label, tone }. ownerId: the owner looking (omit for the student themselves). */
function badgeOf(r, ownerId) {
  if (ownerId ? verifiedFor(r, ownerId) : (r && r.status === "verified")) return { key: "verified", label: "KYC verified", tone: "ok" };
  if (isPendingFor(r, ownerId)) return { key: "pending", label: "KYC pending", tone: "warn" };
  return { key: "none", label: "Not verified", tone: "slate" };
}
/** Records for many mobile numbers at once → Map(phone → record). */
async function recordsFor(phones) {
  const list = [...new Set((phones || []).map(phoneOf).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await KycRecord.find({ phone: { $in: list } }).lean();
  return new Map(rows.map(r => [r.phone, r]));
}
const recordFor = async phone => { const p = phoneOf(phone); return p ? KycRecord.findOne({ phone: p }).lean() : null; };

// Our verification_id: up to 50 letters, digits, ".", "-", "_" (Cashfree's rule).
const newId = () => "HN" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(8).toString("hex");

/**
 * Make a DigiLocker link. returnUrl is where DigiLocker sends the person back;
 * "?vid=<id>" (or "&vid=") is added to it. Returns { url, id }.
 */
async function start({ phone, via, studentId = null, ownerId = null, hostelId = null, shareOwnerId = null, returnUrl }) {
  const p = phoneOf(phone);
  if (!p) throw new cf.CashfreeError("Enter a 10-digit mobile number first.", 0, "bad_phone");
  const id = newId();
  const redirectUrl = returnUrl + (returnUrl.includes("?") ? "&" : "?") + "vid=" + id;
  const r = await cf.createUrl({ verificationId: id, redirectUrl });
  if (!r.data || !r.data.url) throw new cf.CashfreeError("Cashfree did not send a DigiLocker link. Please try again.", 0, "no_url");
  await KycSession.create({ _id: id, phone: p, via, student: studentId, owner: ownerId || shareOwnerId, hostel: hostelId, referenceId: String(r.data.reference_id || "") });
  if (ownerId || shareOwnerId) await noteRequest(p, ownerId || shareOwnerId);   // that owner sees "pending" meanwhile
  const existing = await KycRecord.findOne({ phone: p }, { status: 1 }).lean();
  if (!existing) await KycRecord.create({ phone: p, status: "pending", pendingSince: new Date() }).catch(() => {});
  else if (existing.status !== "verified") await KycRecord.updateOne({ phone: p, status: { $ne: "verified" } }, { $set: { status: "pending", pendingSince: new Date(), lastError: "" } });
  return { url: r.data.url, id };
}

const GENDER = { M: "Male", F: "Female", T: "Other", O: "Other", MALE: "Male", FEMALE: "Female", TRANSGENDER: "Other", OTHER: "Other" };
function dobOf(s) {
  const m = moment.tz(String(s || ""), ["DD-MM-YYYY", "DD/MM/YYYY", "YYYY-MM-DD"], true, TZ);
  return m.isValid() ? m.toDate() : null;
}
const norm = s => String(s || "").toLowerCase().replace(/[^a-zऀ-ॿ]/g, "");
const identityOf = (name, dob, last4) => crypto.createHash("sha256").update(`${norm(name)}|${dob ? moment(dob).tz(TZ).format("YYYY-MM-DD") : ""}|${last4}`).digest("hex");
/** A record's identity (worked out from its details if it was saved without one). */
const idOf = r => (r ? r.identity || (r.name ? identityOf(r.name, r.dob, r.last4) : "") : "");
/** Other verified numbers held by this identity. */
async function othersWith(identity, last4, phone) {
  const list = await KycRecord.find({ status: "verified", phone: { $ne: phone }, $or: [{ identity }, { identity: { $in: ["", null] }, last4 }] },
    { phone: 1, identity: 1, name: 1, dob: 1, last4: 1, via: 1, byOwner: 1, sharedWith: 1, verifiedAt: 1, verificationId: 1 }).lean();
  return list.filter(r => idOf(r) === identity);
}

const fail = async (id, phone, sessionStatus, reason, note) => {
  await KycSession.updateOne({ _id: id }, { $set: { status: sessionStatus, doneAt: new Date() } });
  await KycRecord.updateOne({ phone, status: { $ne: "verified" } }, { $set: { status: "failed", lastError: note || sessionStatus } });
  return { state: "failed", reason };
};

/**
 * After DigiLocker. Returns { state: verified | pending | failed, reason, record, session }.
 * reason (when failed): expired, denied, not_linked, other_person, unknown.
 */
async function finish(id) {
  const session = typeof id === "string" && /^[A-Za-z0-9._-]{1,50}$/.test(id) ? await KycSession.findById(id) : null;
  if (!session) return { state: "failed", reason: "unknown" };
  const recordNow = () => KycRecord.findOne({ phone: session.phone }).lean();
  if (session.status === "DONE") return { state: "verified", record: await recordNow(), session };
  const REASON = { CONSENT_DENIED: "denied", EXPIRED: "expired", NOT_LINKED: "not_linked", OTHER_PERSON: "other_person" };
  if (REASON[session.status]) return { state: "failed", reason: REASON[session.status], session };

  let st;
  try { st = (await cf.status(id)).data || {}; }
  catch (e) { console.error("DigiLocker status (non-fatal):", e.message); return { state: "pending", reason: "error", session }; }
  const status = String(st.status || "").toUpperCase();
  if (status === "PENDING" || !status) return { state: "pending", session };
  if (status === "EXPIRED" || status === "CONSENT_DENIED") return { ...(await fail(id, session.phone, status, REASON[status])), session };
  if (status !== "AUTHENTICATED") return { state: "pending", session };

  // Consent given: fetch the Aadhaar details.
  let doc;
  try {
    const r = await cf.aadhaar(id);
    if (r.status === 202) return { state: "pending", session };
    doc = r.data || {};
  } catch (e) {
    console.error("DigiLocker Aadhaar (non-fatal):", e.message);
    if (e.code === "consent_not_granted") return { ...(await fail(id, session.phone, "CONSENT_DENIED", "denied")), session };
    if (e.code === "session_expired" || e.code === "url_expired") return { ...(await fail(id, session.phone, "EXPIRED", "expired")), session };
    return { state: "pending", reason: "error", session };
  }
  const docStatus = String(doc.status || "").toUpperCase();
  if (docStatus === "AADHAAR_NOT_LINKED") return { ...(await fail(id, session.phone, "NOT_LINKED", "not_linked", "AADHAAR_NOT_LINKED")), session };
  if (docStatus !== "SUCCESS" || !doc.name) return { state: "pending", reason: "error", session };   // try again later

  const digits = String(doc.uid || "").replace(/\D/g, "");
  const linked = String((st.user_details && st.user_details.mobile) || "").replace(/\D/g, "");
  const sa = doc.split_address || {};
  const name = String(doc.name || "").trim().slice(0, 120);
  let dob = dobOf(doc.dob), dobYearOnly = false;
  if (!dob && /^\d{4}$/.test(String(doc.year_of_birth || "").trim())) { dob = moment.tz([Number(doc.year_of_birth), 0, 1], TZ).toDate(); dobYearOnly = true; }
  const last4 = digits.length >= 4 ? digits.slice(-4) : "";
  const identity = identityOf(name, dob, last4);

  // An owner's own earlier check with this Aadhaar (on a mistyped number, say) gives way to this one.
  // (Only when no other owner relies on it: shared with this owner alone.)
  const mine = t => session.via === "owner" && t.via === "owner" && String(t.byOwner || "") === String(session.owner || "")
    && (t.sharedWith || []).every(x => String(x.owner) === String(session.owner));
  const wipe = { status: "failed", name: "", dob: null, dobYearOnly: false, gender: "", state: "", last4: "", identity: "", sharedWith: [] };

  // One number and one Aadhaar are saved by one request at a time (short locks), and each save only lands if the
  // record is still as it was read; otherwise it is decided again.
  for (let wait = 0; wait < 40; wait++) {
    const r = await withLocks(["kyc-phone:" + session.phone, "kyc-identity:" + identity], save);
    if (!r.busy) return r.value;
    await new Promise(z => setTimeout(z, 150));
  }
  return { state: "pending", reason: "busy", session };   // someone else is saving this number or Aadhaar: try again later

  async function save() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await recordNow();
    // (status + last change time + last verification id: a save in between changes at least one)
    const asRead = existing ? { phone: session.phone, status: existing.status,
      ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : { updatedAt: { $exists: false } }),
      ...(existing.verificationId ? { verificationId: existing.verificationId } : {}) } : null;

    // A verified number keeps its person. A student (mobile proven by OTP) may replace a verification
    // made on an owner's phone, or one made by a different HostelNode account (the number changed hands).
    const studentTakesOver = session.via === "student" && existing && (existing.via === "owner" || String(existing.student || "") !== String(session.student || ""));
    if (existing && existing.status === "verified" && idOf(existing) !== identity && !studentTakesOver) {
      return { ...(await fail(id, session.phone, "OTHER_PERSON", "other_person", "A different Aadhaar was used")), session };
    }
    // On an owner's phone, for someone who already verified themselves with this same Aadhaar:
    // keep their own verification and just share it with this owner (they are there in person).
    if (session.via === "owner" && existing && existing.status === "verified" && existing.via === "student" && idOf(existing) === identity) {
      const list = (existing.sharedWith || []).filter(x => String(x.owner) !== String(session.owner));
      list.push({ owner: session.owner, hostel: session.hostel || null, at: new Date() });
      const w = await KycRecord.updateOne(asRead, { $set: { sharedWith: list.slice(-50) } });
      if (!w.matchedCount) continue;
      await KycSession.updateOne({ _id: id }, { $set: { status: "DONE", doneAt: new Date() } });
      return { state: "verified", record: await recordNow(), session };
    }
    // On an owner's phone: one Aadhaar cannot verify a second mobile number.
    if (session.via === "owner" && (await othersWith(identity, last4, session.phone)).some(t => !mine(t))) {
      return { ...(await fail(id, session.phone, "OTHER_PERSON", "other_person", "This Aadhaar already verifies another number")), session };
    }

    // Shared with: the owner on whose phone it was done, or the PG whose link the student used.
    const share = [];
    if (session.owner) share.push({ owner: session.owner, hostel: session.hostel || null, at: new Date() });
    const sameIdentity = existing && idOf(existing) === identity;
    const keepShares = sameIdentity ? (existing.sharedWith || []).filter(x => !share.some(y => String(y.owner) === String(x.owner))) : [];
    const set = {
      status: "verified", name, dob, dobYearOnly,
      gender: GENDER[String(doc.gender || "").trim().toUpperCase()] || "",
      state: String(sa.state || "").trim().slice(0, 60),
      last4, identity,
      verifiedAt: new Date(), verificationId: id, referenceId: String(doc.reference_id || session.referenceId || ""), provider: "cashfree-digilocker",
      via: session.via, student: session.student || null, byOwner: session.via === "owner" ? session.owner : null,
      mobileMatch: linked.length >= 4 ? session.phone.endsWith(linked.slice(-4)) : null,
      pendingSince: null, lastError: "",
      sharedWith: keepShares.concat(share).slice(-50),
    };
    // (doc.photo_link and doc.xml_file are deliberately not kept.)
    if (asRead) {
      const w = await KycRecord.updateOne(asRead, { $set: set });
      if (!w.matchedCount) continue;
    } else {
      try { await KycRecord.create({ phone: session.phone, ...set }); }
      catch (e) { if (e && e.code === 11000) continue; throw e; }
    }
    // Two checks with one Aadhaar finishing at the same moment: an owner-phone one gives way to the
    // person's own verification, and to another owner's check that finished first.
    if (session.via === "owner") {
      const at = set.verifiedAt.getTime();
      const first = t => t.via === "student" || (new Date(t.verifiedAt).getTime() < at) || (new Date(t.verifiedAt).getTime() === at && String(t.verificationId) < id);
      const twins = await othersWith(identity, last4, session.phone);
      if (twins.some(t => !mine(t) && first(t))) {
        await KycRecord.updateOne({ phone: session.phone, verificationId: id }, { $set: { ...wipe, lastError: "This Aadhaar already verifies another number" } });
        await KycSession.updateOne({ _id: id }, { $set: { status: "OTHER_PERSON", doneAt: new Date() } });
        return { state: "failed", reason: "other_person", session };
      }
      // This owner's own earlier check of the same person on another number is replaced by this one.
      for (const t of twins.filter(t => mine(t) && first(t))) {
        await KycRecord.updateOne({ phone: t.phone, verificationId: t.verificationId, status: "verified" }, { $set: { ...wipe, lastError: "Replaced: the same Aadhaar was verified again on " + session.phone.slice(-4).padStart(10, "x") } });
      }
    }
    await KycSession.updateOne({ _id: id }, { $set: { status: "DONE", doneAt: new Date() } });
    return { state: "verified", record: await recordNow(), session };
  }
  return { state: "pending", reason: "busy", session };   // kept changing under us: try again later
  }
}

/** Finish an attempt for this number whose return page was never opened (at most every 10 s per number). */
const lastCatchUp = new Map();
async function catchUp(phone) {
  const p = phoneOf(phone);
  if (!p || Date.now() - (lastCatchUp.get(p) || 0) < 10000) return;
  lastCatchUp.set(p, Date.now());
  if (lastCatchUp.size > 5000) lastCatchUp.clear();
  try {
    const open = await KycSession.find({ phone: p, status: "PENDING", createdAt: { $gte: new Date(Date.now() - 30 * 60e3) } }, { _id: 1 }).sort({ createdAt: -1 }).limit(2).lean();
    for (const s of open) await finish(s._id);
  } catch (e) { console.error("KYC catch-up (non-fatal):", e.message); }
}

/** The person agrees to show their verified details to this owner (property). */
async function share(phone, ownerId, hostelId) {
  const p = phoneOf(phone);
  const r = p ? await KycRecord.findOne({ phone: p }, { status: 1, sharedWith: 1 }).lean() : null;
  if (!r || r.status !== "verified" || !ownerId) return false;
  const list = (r.sharedWith || []).filter(x => String(x.owner) !== String(ownerId));
  list.push({ owner: ownerId, hostel: hostelId || null, at: new Date() });
  await KycRecord.updateOne({ phone: p, status: "verified" }, { $set: { sharedWith: list.slice(-50) } });
  return true;
}

/** An owner asked this person to verify (they then see "pending" for them). Shares nothing. */
async function noteRequest(phone, ownerId) {
  const p = phoneOf(phone);
  if (!p || !ownerId) return;
  const r = await KycRecord.findOne({ phone: p }, { requests: 1 }).lean();
  const requests = ((r && r.requests) || []).filter(x => String(x.owner) !== String(ownerId)).slice(-19);
  requests.push({ owner: ownerId, at: new Date() });
  if (r) await KycRecord.updateOne({ phone: p }, { $set: { requests } });
  else await KycRecord.create({ phone: p, status: "none", requests }).catch(() => KycRecord.updateOne({ phone: p }, { $set: { requests } }));
}

const dobText = (d, yearOnly) => (d ? (yearOnly ? String(moment(d).tz(TZ).year()) : new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })) : "");

module.exports = { phoneOf, settings, forgetSettings, badgeOf, sharedWith, verifiedFor, recordsFor, recordFor, start, finish, catchUp, share, noteRequest, dobText };
