"use strict";

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

function generateAccessToken(userId) {
    const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
      expiresIn: "15m",
    });
    console.log("[generateAccessToken]", { token, timestamp: Date.now() });
    return token;
  }
  
  
  function generateRefreshToken() {
    return crypto.randomBytes(64).toString("hex");
  }
  
  function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }
  
  function getUserIdFromToken(event) {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return decoded.sub;
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        console.warn("[getUserIdFromToken] Access token expired.");
        return "EXPIRED";
      }
      console.error("[getUserIdFromToken] Invalid token:", err);
      return null;
    }
  }

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    hashToken,
    getUserIdFromToken
};