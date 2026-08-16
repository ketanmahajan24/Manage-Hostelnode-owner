/* ============================================================
   Middlewares/jwtAuth.js  —  JWT Authentication
============================================================ */

const jwt = require("jsonwebtoken");

// ================= OWNER AUTH =================
const jwtAuthMiddleware = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect("/login");
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Owner Token Error:", err);
    return res.redirect("/login");
  }
};

// ================= STUDENT AUTH (hard guard) =================
const jwtStudentAuth = (req, res, next) => {
  const token = req.cookies?.studentToken;

  if (!token) {
    return res.redirect("/student/login");
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.student = decoded;
    next();
  } catch (err) {
    console.error("Student Token Error:", err);
    res.clearCookie("studentToken");
    return res.redirect("/student/login");
  }
};

// ================= OPTIONAL STUDENT AUTH =================
const optionalStudentAuth = (req, res, next) => {
  // req.cookies undefined hoga agar cookie-parser nahi laga
  const token = req.cookies?.studentToken;

  if (!token) {
    req.student      = null;
    res.locals.student = null;
    return next();
  }

  try {
    const decoded      = jwt.verify(token, process.env.JWT_SECRET);
    req.student        = decoded;
    res.locals.student = decoded;  // ← EJS templates mein directly available
  } catch (err) {
    req.student        = null;
    res.locals.student = null;
    res.clearCookie("studentToken"); // invalid token clear karo
  }

  next();
};

// ================= TOKEN GENERATOR =================
const generateToken = (data) => {
  return jwt.sign(data, process.env.JWT_SECRET, {
    expiresIn: "7d"
  });
};

// ================= ADMIN AUTH =================
function jwtAdminAuth(req, res, next) {
  const token = req.cookies?.adminToken;

  if (!token) return res.redirect("/admin/login");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "SuperAdmin") return res.redirect("/admin/login");
    req.admin = decoded;
    next();
  } catch {
    res.clearCookie("adminToken");
    return res.redirect("/admin/login");
  }
}

function generateAdminToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "12h" });
}

module.exports = {
  jwtAuthMiddleware,
  jwtStudentAuth,
  optionalStudentAuth,
  generateToken,
  jwtAdminAuth,
  generateAdminToken
}; 