/* ============================================================
   utils/hnSettings.js  —  Admin Console Phase 1
   SHARED: identical in hostelnode.com and manage.hostelnode.com.
   Reads the admin console's switches (models/hnSettings.js), cached
   for 30 seconds, so a change in the admin reaches both sites within
   half a minute. Never throws: on any problem the defaults apply
   (everything on), so a database hiccup never stops a message.
============================================================ */
const TTL_MS = Number(process.env.HN_SETTINGS_CACHE_MS) || 30 * 1000;   // env override is for tests only
const cache = new Map();

const inflight = new Map();   // one database read at a time per switch
async function get(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    let value = {};
    try {
      const S = require("../models/hnSettings");
      const doc = await S.findById(id).lean().maxTimeMS(1500);
      value = (doc && doc.value) || {};
    } catch (err) {
      if (hit) return hit.value;
      value = {};
    }
    cache.set(id, { at: Date.now(), value });
    return value;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** WhatsApp switches → { allOn, isOn(category, template) } */
async function wa() {
  const v = await get("wa");
  const cats = v.categories || {}, tpls = v.templates || {};
  return {
    allOn: v.all !== false,
    isOn: (category, template) => v.all !== false && cats[category] !== false && !(template && tpls[template] === false),
  };
}

/** Tracking settings → { on, gpsPrompt, internalIps:Set, testPhones:Set, testIds:Set } */
async function tracking() {
  const v = await get("tracking");
  const list = a => new Set((Array.isArray(a) ? a : []).map(x => String(x).trim()).filter(Boolean));
  return { on: v.on !== false, gpsPrompt: v.gpsPrompt !== false, internalIps: list(v.internalIps), testPhones: list(v.testPhones), testIds: list(v.testIds) };
}

/** Synchronous peek at the last value read (or null), for hot paths that must not wait. */
function peek(id) { const hit = cache.get(id); return hit ? hit.value : null; }

module.exports = { get, wa, tracking, peek, _cache: cache };
