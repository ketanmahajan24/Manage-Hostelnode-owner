const Visitor  = require("../models/visitor");
const axios    = require("axios");
const UAParser = require("ua-parser-js");

/* ── IP geo cache ── */
const geoCache = new Map();

/* ── Routes to track ── */
const TRACKED_ROUTES = [
  { pattern: /^\/$/, label: "Home" },
  { pattern: /^\/student\/login/, label: "Student Login" },
  { pattern: /^\/student\/signup/, label: "Student Signup" },
  { pattern: /^\/student$/, label: "Student Dashboard" },
  { pattern: /^\/student\/wishlist/, label: "Student Wishlist" },
  { pattern: /^\/login/, label: "Owner Login" },
  { pattern: /^\/signup/, label: "Owner Signup" },
  { pattern: /^\/findHostels$/, label: "Find Hostels" },
  { pattern: /^\/findHostels\/results/, label: "Search Results" },
  { pattern: /^\/hostel\/[^/]+$/, label: "Hostel Detail" },
  { pattern: /^\/user$/, label: "Owner Dashboard" },
  { pattern: /^\/user\/my-listings/, label: "My Listings" },
];

/* ── Get real IP ── */
function getRealIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.ip ||
    "0.0.0.0"
  ).replace("::ffff:", "");
}

/* ── Parse device ── */
function parseDevice(ua) {
  const parser = new UAParser(ua);
  const result = parser.getResult();
  const deviceType = result.device?.type;
  let device = "Desktop";
  if (deviceType === "mobile") device = "Mobile";
  else if (deviceType === "tablet") device = "Tablet";
  else if (/bot|crawl|spider|slurp/i.test(ua)) device = "Bot";
  return {
    browser: `${result.browser?.name || "Unknown"} ${result.browser?.version || ""}`.trim(),
    os:      `${result.os?.name || "Unknown"} ${result.os?.version || ""}`.trim(),
    device
  };
}

/* ── Fetch geo from IP ── */
async function getGeo(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);

  if (
    ip === "127.0.0.1" || ip === "::1" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.")
  ) {
    return { country: "Local", region: "Local", city: "Local", lat: null, lng: null, timezone: null, isp: "Local" };
  }

  try {
    const res = await axios.get(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,timezone,isp`,
      { timeout: 3000 }
    );
    if (res.data?.status === "success") {
      const geo = {
        country:  res.data.country,
        region:   res.data.regionName,
        city:     res.data.city,
        lat:      res.data.lat,
        lng:      res.data.lon,
        timezone: res.data.timezone,
        isp:      res.data.isp
      };
      geoCache.set(ip, geo);
      setTimeout(() => geoCache.delete(ip), 10 * 60 * 1000);
      return geo;
    }
  } catch (err) {}

  return { country: null, region: null, city: null, lat: null, lng: null, timezone: null, isp: null };
}

/* ── Main tracking middleware ── */
const visitorTracker = async (req, res, next) => {
  next(); // never block request

  setImmediate(async () => {
    try {
      const path = req.path;
      const match = TRACKED_ROUTES.find(r => r.pattern.test(path));
      if (!match) return;

      const ip = getRealIp(req);
      const ua = req.headers["user-agent"] || "";
      const { browser, os, device } = parseDevice(ua);
      const isReturning = await Visitor.exists({ ip });
      const geo = await getGeo(ip);

      let userId   = null;
      let userType = null;
      if (req.student)    { userId = req.student.id; userType = "Student"; }
      else if (req.user)  { userId = req.user.id;    userType = "Owner"; }
      else if (req.admin) { userId = req.admin.id;   userType = "Admin"; }

      await Visitor.create({
        ip,
        route:      path,
        routeLabel: match.label,
        method:     req.method,
        country:    geo.country,
        region:     geo.region,
        city:       geo.city,
        lat:        geo.lat,       // IP-based lat (approximate)
        lng:        geo.lng,       // IP-based lng (approximate)
        timezone:   geo.timezone,
        isp:        geo.isp,
        userAgent:  ua.substring(0, 300),
        browser,
        os,
        device,
        referrer:    req.headers.referer || null,
        sessionId:   req.cookies?.sessionId || req.sessionID || null,
        isReturning: !!isReturning,
        userId,
        userType,
        locationSource: "IP",   // ✅ starts as IP, upgraded to GPS if user allows
        visitedAt: new Date()
      });

    } catch (err) {
      console.error("Visitor track error:", err.message);
    }
  });
};


/* ── ✅ GPS LOCATION ROUTE ──────────────────────────────────────
   Browser sends real GPS lat/lng → we update the latest visitor record
   Add this route in your main app.js or index.js:
   app.post("/track-location", trackGpsLocation);
─────────────────────────────────────────────────────────────── */
const trackGpsLocation = async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;

    // Basic validation
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      return res.json({ success: false });
    }

    const ip = getRealIp(req);

    // ✅ Update the most recent visit record for this IP with real GPS
    await Visitor.findOneAndUpdate(
      { ip },
      {
        gpsLat:         parseFloat(lat),
        gpsLng:         parseFloat(lng),
        gpsAccuracy:    parseFloat(accuracy) || null,
        locationSource: "GPS"   // ✅ mark as real GPS now
      },
      {
        sort:  { visitedAt: -1 },  // update most recent visit
        new:   true
      }
    );

    res.json({ success: true });

  } catch (err) {
    console.error("GPS track error:", err.message);
    res.json({ success: false });
  }
};


module.exports = { visitorTracker, trackGpsLocation };
