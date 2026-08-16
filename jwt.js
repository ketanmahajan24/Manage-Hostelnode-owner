const jwt = require('jsonwebtoken');

const jwtAuthMiddleware = (req, res, next) => {

    // Read token from cookies
    const token = req.cookies.token;
    if (!token) {
        return res.redirect("/login"); // If no token, redirect to login
    }

    try {
        // Verify the JWT Token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        console.error(err);
        res.status(401).json({ error: 'Invalid Token' });
    }
}

const generateToken = (userData) => {
    return jwt.sign(userData, process.env.JWT_SECRET, { expiresIn: '7d' });
}


module.exports = { jwtAuthMiddleware, generateToken };
