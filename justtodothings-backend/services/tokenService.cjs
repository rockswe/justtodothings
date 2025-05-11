"use strict";

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { parseCookies } = require("../utils/cookieHelper.cjs");
const { pool } = require("../config/db.cjs");

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
  
  async function getUserIdFromToken(event) {
    // 1. Try Authorization header first
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.sub) {
          console.log("[getUserIdFromToken] User ID found via Authorization header:", decoded.sub);
          return decoded.sub;
        }
      } catch (err) {
        if (err.name === "TokenExpiredError") {
          console.warn("[getUserIdFromToken] Access token from header expired.");
          // For expired access token in header, we might still want to check refresh token cookie
        } else {
          console.error("[getUserIdFromToken] Invalid access token from header:", err.message);
          // For other invalid token errors from header, also fall through to check cookie
        }
      }
    }

    // 2. If no valid Authorization header, try refreshToken cookie
    const rawCookieHeader =
      event.headers?.cookie ||
      event.headers?.Cookie ||
      (event.multiValueHeaders?.cookie?.[0]) ||
      (event.cookies?.join("; ")) || "";
    
    const cookies = parseCookies(rawCookieHeader);
    const clientRefreshToken = cookies.refreshToken;

    if (!clientRefreshToken) {
      console.log("[getUserIdFromToken] No Authorization header and no refreshToken cookie found.");
      return null;
    }

    console.log("[getUserIdFromToken] Attempting to validate refreshToken from cookie.");
    const tokenHash = hashToken(clientRefreshToken);
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT user_id, expires_at, is_revoked FROM refresh_tokens WHERE token_hash = $1`,
        [tokenHash]
      );

      if (result.rows.length === 0) {
        console.warn("[getUserIdFromToken] Refresh token from cookie: No matching token hash found in DB.");
        return null;
      }

      const dbToken = result.rows[0];
      if (dbToken.is_revoked) {
        console.warn("[getUserIdFromToken] Refresh token from cookie is revoked for user ID:", dbToken.user_id);
        // Optionally, revoke all tokens for this user if a revoked token is used
        // await client.query(`UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`, [dbToken.user_id]);
        return null;
      }

      if (new Date(dbToken.expires_at) < new Date()) {
        console.warn("[getUserIdFromToken] Refresh token from cookie is expired. DB expires_at:", dbToken.expires_at);
        return null;
      }
      
      console.log("[getUserIdFromToken] User ID found via refreshToken cookie:", dbToken.user_id);
      return dbToken.user_id; // Successfully authenticated via refresh token cookie

    } catch (dbErr) {
      console.error("[getUserIdFromToken] DB error while validating refresh token from cookie:", dbErr);
      return null;
    } finally {
      client.release();
    }
  }

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    hashToken,
    getUserIdFromToken
};