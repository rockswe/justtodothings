"use strict";

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const axios = require("axios");
const { google } = require("googleapis");
const { parse } = require("cookie"); // Used by googleAuthCallback

const { pool } = require("../config/db.cjs");
const { buildResponse } = require("../utils/responseHelper.cjs");
const { parseCookies, buildRefreshTokenCookie } = require("../utils/cookieHelper.cjs");
const {
    generateAccessToken,
    generateRefreshToken,
    hashToken,
    getUserIdFromToken
} = require("../services/tokenService.cjs");
const { sendResetEmailHTML, sendVerificationEmail } = require("../services/emailService.cjs");
const {
    signupSchema,
    loginSchema,
    forgotPasswordSchema,
    resetPasswordSchema
} = require("../validation/authSchemas.cjs");


async function refreshToken(event) {
    console.log(">>> FULL EVENT", JSON.stringify(event, null, 2));
    const rawCookieHeader =
    event.headers?.cookie ||
    event.headers?.Cookie ||
    (event.multiValueHeaders?.cookie?.[0]) ||
    (event.cookies?.join("; ")) || ""; // ✅ API Gateway HTTP API format
  
    console.log("[refreshToken] Raw cookie header:", rawCookieHeader);
    
    const cookies = parseCookies(rawCookieHeader);
    console.log("[refreshToken] Parsed cookies:", cookies); // Added log

    const oldToken = cookies.refreshToken; 
    console.log("[refreshToken] Old refresh token found from cookies:", oldToken); // Added log
  
    if (!oldToken) {
      console.log("[refreshToken] Refresh token cookie not found in parsed cookies."); // Modified log
      return buildResponse(401, { message: "No refresh token found in cookies." });
    }

    const oldTokenHash = hashToken(oldToken);
    console.log("[refreshToken] Old refresh token hash:", oldTokenHash); // Added log
  
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, user_id, expires_at, is_revoked FROM refresh_tokens WHERE token_hash = $1`,
        [oldTokenHash]
      );
  
      if (result.rows.length === 0) {
        console.warn("[refreshToken] Invalid refresh token: No matching token hash found in DB."); // Added log
        return buildResponse(401, { message: "Invalid refresh token." });
      }
  
      const token = result.rows[0];
      console.log("[refreshToken] DB token status:", { id: token.id, userId: token.user_id, expiresAt: token.expires_at, isRevoked: token.is_revoked }); // Added log
  
      if (token.is_revoked) {
        console.warn("[refreshToken] Refresh token reuse detected for user ID:", token.user_id); // Added log
        await client.query(`UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`, [token.user_id]);
        return buildResponse(401, { message: "Refresh token reuse detected. All sessions revoked." });
      }
  
      if (new Date(token.expires_at) < new Date()) {
        console.warn("[refreshToken] Refresh token expired. DB expires_at:", token.expires_at); // Added log
        return buildResponse(401, { message: "Refresh token expired." });
      }
  
      console.log("[refreshToken] Revoking old token ID:", token.id); // Added log
      await client.query(
        `UPDATE refresh_tokens SET is_revoked = true WHERE id = $1`,
        [token.id]
      );
  
      const newRefreshToken = generateRefreshToken();
      const newRefreshTokenHash = hashToken(newRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      console.log("[refreshToken] Generated new refresh token. DB ExpiresAt set to:", refreshExpiresAt); // Added log
  
      const sourceIp = event?.requestContext?.http?.sourceIp
                     ?? event?.requestContext?.identity?.sourceIp
                     ?? null;
      const userAgent = event?.headers?.["user-agent"] ?? event?.headers?.["User-Agent"] ?? null;
  
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          token.user_id,
          newRefreshTokenHash,
          refreshExpiresAt,
          userAgent,
          sourceIp,
        ]
      );
      console.log("[refreshToken] New refresh token stored in DB for user ID:", token.user_id); // Added log
  
      const newAccessToken = generateAccessToken(token.user_id);
      console.log("[refreshToken] Issuing new access token for user ID:", token.user_id); // Added log
      
      // Use rememberMe=true because we're extending an existing session
      const cookieHeader = buildRefreshTokenCookie(newRefreshToken, true);
      console.log("[refreshToken] Setting new refresh token cookie. RememberMe hardcoded to true."); // Added log
  
      return buildResponse(
        200,
        { accessToken: newAccessToken },
        { "Set-Cookie": cookieHeader }
      );
    } catch (err) {
      console.error("[refreshToken] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }

// POST /delete-account
async function deleteAccount(event) {
  // 1. Parse user ID from JWT
  const userId = await getUserIdFromToken(event);
  if (!userId) {
    return buildResponse(401, { message: "Unauthorized" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Delete related records in email_verifications
    const deleteEmailVerificationsQuery = `
      DELETE FROM email_verifications
      WHERE user_id = $1
    `;
    await client.query(deleteEmailVerificationsQuery, [userId]);

    // Delete related records in password_resets
    const deletePasswordResetsQuery = `
      DELETE FROM password_resets
      WHERE user_id = $1
    `;
    await client.query(deletePasswordResetsQuery, [userId]);

    // Delete tasks (if not using ON DELETE CASCADE)
    const deleteTasksQuery = `
      DELETE FROM tasks
      WHERE user_id = $1
    `;
    await client.query(deleteTasksQuery, [userId]);

    // Finally, delete the user
    const deleteUserQuery = `
      DELETE FROM users
      WHERE id = $1
    `;
    await client.query(deleteUserQuery, [userId]);

    await client.query("COMMIT");
    return buildResponse(200, { message: "Account deleted successfully." });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[deleteAccount] ROLLBACK Error:", rollbackErr);
    }
    console.error("[deleteAccount] Error:", err);
    return buildResponse(500, { message: "Internal server error. Account not deleted." });
  } finally {
    client.release();
  }
}


// POST /signup
async function signup(event) {
    const data = JSON.parse(event.body || "{}");
    const { error, value } = signupSchema.validate(data);
    if (error) {
      return buildResponse(400, { message: error.details[0].message });
    }
    const { email, password, passwordAgain } = value;
    if (password !== passwordAgain) {
      return buildResponse(400, { message: "Passwords do not match." });
    }
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const client = await pool.connect();
    try {
      const insertUserQuery = `
        INSERT INTO users (email, password_hash, is_verified)
        VALUES ($1, $2, false)
        RETURNING id, email
      `;
      const result = await client.query(insertUserQuery, [email.toLowerCase(), hashedPassword]);
      const user = result.rows[0];
      
      // Generate verification token (24-hour expiry)
      const verificationToken = uuidv4();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const insertVerificationQuery = `
        INSERT INTO email_verifications (id, user_id, expires_at)
        VALUES ($1, $2, $3)
      `;
      await client.query(insertVerificationQuery, [verificationToken, user.id, expiresAt]);
      
      try {
        await sendVerificationEmail(user.email, verificationToken);
      } catch (emailErr) {
        console.error("[signup] Error sending verification email:", emailErr);
      }
      
      return buildResponse(201, {
        message: "User created successfully. Please verify your email to activate your account.",
        userId: user.id
      });
    } catch (err) {
      if (err.code === "23505") {
        return buildResponse(409, { message: "Email already exists." });
      }
      console.error("[signup] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
  async function login(event) {
    const data = JSON.parse(event.body || "{}");
    const { error, value } = loginSchema.validate(data);
    if (error) return buildResponse(400, { message: error.details[0].message });
  
    const { email, password, rememberMe } = value;
    console.log("[login] Attempting login for email:", email, "Remember me:", rememberMe); // Added log
  
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT id, password_hash, is_verified, is_disabled FROM users WHERE email = $1",
        [email.toLowerCase()]
      );
  
      if (result.rows.length === 0 || !(await bcrypt.compare(password, result.rows[0].password_hash))) {
        console.warn("[login] Invalid credentials for email:", email); // Added log
        return buildResponse(401, { message: "Invalid credentials." });
      }
  
      const user = result.rows[0];
      console.log("[login] User found:", { id: user.id, verified: user.is_verified, disabled: user.is_disabled }); // Added log
      if (user.is_disabled) {
        console.warn("[login] Account disabled for user ID:", user.id); // Added log
        return buildResponse(403, { message: "Account disabled." });
      }
      if (!user.is_verified) {
        console.warn("[login] Email not verified for user ID:", user.id); // Added log
        return buildResponse(403, { message: "Verify your email." });
      }
  
      const accessToken = generateAccessToken(user.id);
      console.log("[login] Generating access token for user ID:", user.id); // Added log
      const refreshToken = generateRefreshToken();
      const refreshTokenHash = hashToken(refreshToken);
      const refreshExpiresAt = rememberMe
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
        : new Date(Date.now() + 1 * 24 * 60 * 60 * 1000); // 1 day
      console.log("[login] Generating refresh token. DB ExpiresAt:", refreshExpiresAt, "RememberMe:", rememberMe); // Added log
  
      const sourceIp = event?.requestContext?.http?.sourceIp
                     ?? event?.requestContext?.identity?.sourceIp
                     ?? null;
      const userAgent = event?.headers?.["user-agent"] ?? event?.headers?.["User-Agent"] ?? null;
  
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          user.id,
          refreshTokenHash,
          refreshExpiresAt,
          userAgent, 
          sourceIp,
        ]
      );
      console.log("[login] Refresh token stored in DB for user ID:", user.id); // Added log
  
      const cookieHeader = buildRefreshTokenCookie(refreshToken, rememberMe);
      console.log("[login] Setting refresh token cookie. RememberMe:", rememberMe); // Added log
  
      return buildResponse(
        200,
        { accessToken, message: "Login successful." },
        { "Set-Cookie": cookieHeader }
      );
    } catch (err) {
      // Add more specific logging if needed
      console.error("[login] Error:", err); // Keep this log
      // Check if it's the TypeError again, though the fix should prevent it
      if (err instanceof TypeError && err.message.includes("sourceIp")) {
          console.error("[login] Problematic event structure:", JSON.stringify(event?.requestContext ?? {}, null, 2));
      }
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }

  async function logout(event) {
    // Use more robust cookie parsing from refreshToken function
    const rawCookieHeader =
      event.headers?.cookie ||
      event.headers?.Cookie ||
      (event.multiValueHeaders?.cookie?.[0]) ||
      (event.cookies?.join("; ")) || "";

    console.log("[logout] Raw cookie header for logout:", rawCookieHeader); // Added for debugging

    const cookies = parseCookies(rawCookieHeader);
    const clientRefreshToken = cookies.refreshToken;
    
    if (clientRefreshToken) {
      console.log("[logout] Refresh token found in cookies (first 10 chars):", clientRefreshToken.substring(0,10));
      const tokenHash = hashToken(clientRefreshToken);
      console.log("[logout] Attempting to revoke token hash in DB:", tokenHash);
      const client = await pool.connect();
      try {
        const result = await client.query(`UPDATE refresh_tokens SET is_revoked = true WHERE token_hash = $1 RETURNING id`, [tokenHash]);
        if (result.rowCount > 0) {
          console.log("[logout] Token hash revoked in DB. Revoked token ID(s):", result.rows.map(r => r.id));
        } else {
          console.warn("[logout] Token hash not found in DB for revocation, or already revoked:", tokenHash);
        }
      } catch (err) {
        console.error("[logout] Error revoking token in DB:", err);
        // Do not return here, still proceed to clear cookie
      } finally {
        client.release();
      }
    } else {
      console.log("[logout] No refreshToken cookie found by robust parser. Proceeding to clear cookie instruction.");
    }
  
    // Always attempt to clear the cookie on the client side
    // Use attributes consistent with how the cookie was set (SameSite=None, Domain)
    const clearCookieHeader = `refreshToken=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=None; Domain=.justtodothings.com`;
    console.log("[logout] Sending Set-Cookie header to clear refreshToken:", clearCookieHeader);
    
    return buildResponse(200, { message: "Logged out." }, {
      "Set-Cookie": clearCookieHeader,
    });
  }
  
  
  
  // POST /forgot-password
  async function forgotPassword(event) {
    const data = JSON.parse(event.body || "{}");
    const { error, value } = forgotPasswordSchema.validate(data);
    if (error) {
      return buildResponse(400, { message: error.details[0].message });
    }
    const { email } = value;
    
    const client = await pool.connect();
    try {
      const userQuery = `SELECT id FROM users WHERE email = $1`;
      const userResult = await client.query(userQuery, [email.toLowerCase()]);
      if (userResult.rows.length === 0) {
        return buildResponse(200, { message: "If that email exists, a reset link was sent." });
      }
      const userId = userResult.rows[0].id;
      
      const resetId = uuidv4();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour expiry
      const insertResetQuery = `
        INSERT INTO password_resets (id, user_id, expires_at)
        VALUES ($1, $2, $3)
      `;
      await client.query(insertResetQuery, [resetId, userId, expiresAt]);
      
      try {
        await sendResetEmailHTML(email, resetId);
      } catch (emailErr) {
        console.error("[forgotPassword] Error sending email:", emailErr);
      }
      
      return buildResponse(200, { message: "If that email exists, a reset link was sent." });
    } catch (err) {
      console.error("[forgotPassword] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
  // POST /reset-password/{uuid}
  async function resetPassword(event) {
    const { uuid } = event.pathParameters || {};
    if (!uuid) {
      return buildResponse(400, { message: "Reset token is required." });
    }
    const data = JSON.parse(event.body || "{}");
    const { error, value } = resetPasswordSchema.validate(data);
    if (error) {
      return buildResponse(400, { message: error.details[0].message });
    }
    const { password, passwordAgain } = value;
    if (password !== passwordAgain) {
      return buildResponse(400, { message: "Passwords do not match." });
    }
    
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const client = await pool.connect();
    try {
      const resetQuery = `
        SELECT user_id, used, expires_at
        FROM password_resets
        WHERE id = $1
      `;
      const resetResult = await client.query(resetQuery, [uuid]);
      if (resetResult.rows.length === 0) {
        return buildResponse(400, { message: "Invalid or expired reset token." });
      }
      const resetRecord = resetResult.rows[0];
      if (resetRecord.used) {
        return buildResponse(400, { message: "This reset token has already been used." });
      }
      if (new Date(resetRecord.expires_at) < new Date()) {
        return buildResponse(400, { message: "This reset token has expired." });
      }
      const updateUserQuery = `UPDATE users SET password_hash = $1 WHERE id = $2`;
      await client.query(updateUserQuery, [hashedPassword, resetRecord.user_id]);
      const markUsedQuery = `UPDATE password_resets SET used = true WHERE id = $1`;
      await client.query(markUsedQuery, [uuid]);
      return buildResponse(200, { message: "Password has been reset." });
    } catch (err) {
      console.error("[resetPassword] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
// GET /verification/{uuid}
async function verifyEmail(event) {
  const { uuid } = event.pathParameters || {};
  if (!uuid) {
    return buildResponse(400, { message: "Verification token is required." });
  }

  const client = await pool.connect();
  try {
    // 1. Check if token exists
    const selectQuery = `
      SELECT user_id, activated, expires_at
      FROM email_verifications
      WHERE id = $1
    `;
    const result = await client.query(selectQuery, [uuid]);
    if (result.rows.length === 0) {
      return buildResponse(400, { message: "Invalid or expired verification token." });
    }

    const record = result.rows[0];

    // 2. Check if token was already used
    if (record.activated) {
      return buildResponse(400, { message: "This token has already been used." });
    }

    // 3. Check if token is expired
    if (new Date(record.expires_at) < new Date()) {
      // a) Token is expired -> send a new verification link

      // i. Fetch user email
      const userEmailQuery = `SELECT email FROM users WHERE id = $1`;
      const userEmailResult = await client.query(userEmailQuery, [record.user_id]);
      if (userEmailResult.rows.length === 0) {
        return buildResponse(400, { message: "User not found for this token." });
      }
      const userEmail = userEmailResult.rows[0].email;

      // ii. Generate a new verification token
      const newToken = uuidv4();
      const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // iii. Insert the new token
      const insertNewTokenQuery = `
        INSERT INTO email_verifications (id, user_id, expires_at)
        VALUES ($1, $2, $3)
      `;
      await client.query(insertNewTokenQuery, [newToken, record.user_id, newExpiresAt]);

      // iv. Send new verification email
      try {
        await sendVerificationEmail(userEmail, newToken);
      } catch (emailErr) {
        console.error("[verifyEmail] Error sending new verification email:", emailErr);
        // You can decide whether to fail or continue
      }

      return buildResponse(400, {
        message: "This token has expired. A new verification link has been sent to your email."
      });
    }

    // 4. Otherwise, token is valid. Mark user as verified
    await client.query(`UPDATE users SET is_verified = true WHERE id = $1`, [record.user_id]);
    // Mark the token as activated
    await client.query(`UPDATE email_verifications SET activated = true WHERE id = $1`, [uuid]);

    return buildResponse(200, { message: "Email verified successfully." });
  } catch (err) {
    console.error("[verifyEmail] Error:", err);
    return buildResponse(500, { message: "Internal server error." });
  } finally {
    client.release();
  }
}

// GOOGLE OAUTH: /auth/google (Redirect) - Updated with State and Domain
async function googleAuthRedirect(event) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];

  // 1. Generate state
  const state = crypto.randomBytes(16).toString('hex');

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
    state: state
  });

  // 3. Create state cookie header WITH Domain attribute
const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=600; Domain=.justtodothings.com`;

  return {
    statusCode: 302,
    headers: {
      Location: url,
      "Set-Cookie": stateCookie // 4. Set the state cookie
    },
    body: "",
  };
}
  
async function googleAuthCallback(event) {
  const query = event.queryStringParameters || {};
  const { code, state: returnedState } = query;

  // Define header to clear the state cookie (needed in all response paths)
  const clearStateCookie = "oauth_state=; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=0; Domain=.justtodothings.com";

  if (!code) {
    // For HTTP API, directly return the object. buildResponse might add Content-Type: application/json which isn't ideal for a pure redirect response.
    const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=google_missing_code";
    return {
        statusCode: 302,
        headers: { Location: frontendErrorUrl },
        cookies: [clearStateCookie], // Clear state cookie on error
        body: "",
    };
  }

  // --- Parse cookies safely ---
  let cookiesFromEvent = {};
  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieHeader = event.cookies.join("; ");
    cookiesFromEvent = parse(cookieHeader);
  } else if (event.headers?.cookie) { // Fallback for older structures or direct testing
    cookiesFromEvent = parse(event.headers.cookie);
  }


  // --- Validate state ---
  const expectedState = cookiesFromEvent["oauth_state"];

  if (!expectedState || expectedState !== returnedState) {
    console.warn("[googleAuthCallback] Invalid or missing state. Potential CSRF.");
    const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=invalid_state";
    return {
      statusCode: 302,
      headers: { Location: frontendErrorUrl },
      cookies: [clearStateCookie], // Clear state cookie
      body: "",
    };
  }

  // --- Google OAuth setup ---
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfoRes = await oauth2.userinfo.get();
    const { email } = userInfoRes.data;

    if (!email) {
      console.error("[googleAuthCallback] Unable to retrieve email from Google.");
       const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=google_no_email";
       return {
         statusCode: 302,
         headers: { Location: frontendErrorUrl },
         cookies: [clearStateCookie], // Clear state cookie
         body: "",
       };
    }

    const client = await pool.connect();
    let user;

    try {
      const res = await client.query(
        `SELECT id, is_disabled FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );

      if (res.rows.length > 0) {
        user = res.rows[0];
        if (user.is_disabled) {
            console.warn('[googleAuthCallback] Account disabled for user ID: ' + user.id);
            const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=account_disabled";
            return {
                statusCode: 302,
                headers: { Location: frontendErrorUrl },
                cookies: [clearStateCookie], // Clear state cookie
                body: "",
            };
        }
      } else {
        const dummyHash = await bcrypt.hash(uuidv4(), 10);
        const insertRes = await client.query(
          `INSERT INTO users (email, password_hash, is_verified, terms_accepted)
           VALUES ($1, $2, true, true)
           RETURNING id, email, is_disabled`,
          [email.toLowerCase(), dummyHash]
        );
        user = insertRes.rows[0];
        console.log('[googleAuthCallback] New user created via Google OAuth: ' + email + ' (ID: ' + user.id + ')');
      }

      const newRefreshToken = generateRefreshToken();
      const newRefreshTokenHash = hashToken(newRefreshToken);
      const rememberMe = true;
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const sourceIp = event?.requestContext?.http?.sourceIp ?? event?.requestContext?.identity?.sourceIp ?? null;
      const userAgent = event?.headers?.["user-agent"] ?? event?.headers?.["User-Agent"] ?? null;

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, newRefreshTokenHash, refreshExpiresAt, userAgent, sourceIp]
      );

      const refreshTokenCookieHeader = buildRefreshTokenCookie(newRefreshToken, rememberMe);
      
      const baseRedirectUrl = process.env.APP_BASE_URL
        ? process.env.APP_BASE_URL
        : "https://www.justtodothings.com/";
      // Add oauth_success=true to the redirect URL
      const frontendRedirectUrl = `${baseRedirectUrl}${baseRedirectUrl.includes("?") ? "&" : "?"}oauth_success=true`;

      return {
        statusCode: 302,
        headers: { Location: frontendRedirectUrl },
        cookies: [refreshTokenCookieHeader, clearStateCookie], // Corrected for HTTP API
        body: "",
      };

    } finally {
      client.release();
    }

  } catch (err) {
    console.error("[googleAuthCallback] OAuth or DB error:", err.response?.data || err.message || err);
    const errorCode = axios.isAxiosError(err) ? "google_api_error" : "google_failed";
    const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + '/login?error=' + errorCode;
    return {
      statusCode: 302,
      headers: { Location: frontendErrorUrl },
      cookies: [clearStateCookie], // Clear state cookie on error
      body: "",
    };
  }
}
  
  // GITHUB OAUTH: /auth/github (Redirect) - Updated with State
  async function githubAuthRedirect(event) {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = process.env.GITHUB_REDIRECT_URI;
    const scope = "read:user user:email";

    // 1. Generate state
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scope,
        state: state // 2. Include state in URL params
    });

    const url = `https://github.com/login/oauth/authorize?${params.toString()}`;

    const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=600; Domain=.justtodothings.com`;

    return {
      statusCode: 302,
      headers: {
          Location: url,
      },
      cookies: [stateCookie],
      body: "",
    };
  }

// GITHUB OAUTH CALLBACK: /auth/github/callback - Final Version with State Validation
async function githubAuthCallback(event) {
    const query = event.queryStringParameters || {};
    const { code, state: returnedState } = query;
  
    // For HTTP API, event.cookies is an array of strings. parseCookies expects a single string.
    let eventCookieHeader = "";
    if (event.cookies && Array.isArray(event.cookies)) {
      eventCookieHeader = event.cookies.join('; ');
    } else if (event.headers?.cookie || event.headers?.Cookie) { // Fallback for older structures or direct testing
      eventCookieHeader = event.headers.cookie || event.headers.Cookie;
    }
    const cookiesFromEvent = parseCookies(eventCookieHeader);
    const expectedState = cookiesFromEvent.oauth_state;

    // It's good practice to always attempt to clear the state cookie, even on error
    const clearStateCookie = "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0; Domain=.justtodothings.com"; // Matched SameSite with githubAuthRedirect
  
    if (!returnedState || !expectedState || returnedState !== expectedState) {
      console.error("[githubAuthCallback] State mismatch error.", { returnedState, expectedState });
      const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=invalid_state";
      return { 
        statusCode: 302, 
        headers: { Location: frontendErrorUrl }, 
        cookies: [clearStateCookie], // Corrected for HTTP API
        body: "" 
      };
    }
  
    if (!code) {
       const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=github_missing_code";
       return { 
        statusCode: 302, 
        headers: { Location: frontendErrorUrl }, 
        cookies: [clearStateCookie], // Corrected for HTTP API
        body: "" 
      };
    }
  
    let client;
    try {
      const tokenRes = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: process.env.GITHUB_REDIRECT_URI,
        },
        { headers: { Accept: "application/json" } }
      );
  
      const githubAccessToken = tokenRes.data.access_token;
      if (!githubAccessToken) {
         const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=github_token_exchange";
         return { 
            statusCode: 302, 
            headers: { Location: frontendErrorUrl }, 
            cookies: [clearStateCookie], // Corrected for HTTP API
            body: "" 
        };
      }
  
      const emailsRes = await axios.get("https://api.github.com/user/emails", {
         headers: { Authorization: `Bearer ${githubAccessToken}` },
      });
  
      let primaryVerifiedEmail = null;
      if (emailsRes.data && Array.isArray(emailsRes.data)) {
         const primaryEmailData = emailsRes.data.find(e => e.primary && e.verified);
         primaryVerifiedEmail = primaryEmailData?.email ?? emailsRes.data.find(e => e.verified)?.email;
      }
  
      if (!primaryVerifiedEmail) {
         const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=github_no_verified_email";
         return { 
            statusCode: 302, 
            headers: { Location: frontendErrorUrl }, 
            cookies: [clearStateCookie], // Corrected for HTTP API
            body: "" 
        };
      }
  
      const lowerCaseEmail = primaryVerifiedEmail.toLowerCase();
      client = await pool.connect();
  
      let user;
      const selectQuery = `SELECT id, is_disabled FROM users WHERE email = $1`;
      const selectResult = await client.query(selectQuery, [lowerCaseEmail]);
  
      if (selectResult.rows.length > 0) {
        user = selectResult.rows[0];
        if (user.is_disabled) {
            const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + "/login?error=account_disabled";
            return { 
                statusCode: 302, 
                headers: { Location: frontendErrorUrl }, 
                cookies: [clearStateCookie], // Corrected for HTTP API
                body: "" 
            };
        }
      } else {
        const insertQuery = `
            INSERT INTO users (email, password_hash, is_verified, terms_accepted)
            VALUES ($1, $2, true, true) RETURNING id, is_disabled `;
        const dummyHash = await bcrypt.hash(uuidv4(), 12);
        const insertResult = await client.query(insertQuery, [lowerCaseEmail, dummyHash]);
        user = insertResult.rows[0];
        console.log(`[githubAuthCallback] New user created via GitHub OAuth: ${lowerCaseEmail} (ID: ${user.id})`);
      }
  
      const refreshToken = generateRefreshToken();
      const refreshTokenHash = hashToken(refreshToken);
      const rememberMe = true;
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); 
  
      const sourceIp = event?.requestContext?.http?.sourceIp
                     ?? event?.requestContext?.identity?.sourceIp
                     ?? null;
      const userAgent = event?.headers?.["user-agent"] ?? event?.headers?.["User-Agent"] ?? null;
  
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
        VALUES ($1, $2, $3, $4, $5) `,
        [ user.id, refreshTokenHash, refreshExpiresAt, userAgent, sourceIp ]
      );
  
      const refreshTokenCookieHeader = buildRefreshTokenCookie(refreshToken, rememberMe);
      const baseRedirectUrl = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}` : "https://www.justtodothings.com/";
      // Add oauth_success=true to the redirect URL
      const frontendRedirectUrl = `${baseRedirectUrl}${baseRedirectUrl.includes("?") ? "&" : "?"}oauth_success=true`;
  
      return {
        statusCode: 302,
        headers: { Location: frontendRedirectUrl },
        cookies: [refreshTokenCookieHeader, clearStateCookie], // Corrected for HTTP API
        body: "",
      };
  
    } catch (err) {
      console.error("[githubAuthCallback] Error processing GitHub callback:", err.response?.data || err.message || err);
      const errorCode = axios.isAxiosError(err) ? "github_api_error" : "github_failed";
      const frontendErrorUrl = (process.env.APP_BASE_URL || "https://www.justtodothings.com") + `/login?error=${errorCode}`;
      return { 
        statusCode: 302, 
        headers: { Location: frontendErrorUrl }, 
        cookies: [clearStateCookie], // Corrected for HTTP API
        body: "" 
      };
    } finally {
      if (client) { client.release(); }
    }
  }

module.exports = {
    refreshToken,
    deleteAccount,
    signup,
    login,
    logout,
    forgotPassword,
    resetPassword,
    verifyEmail,
    googleAuthRedirect,
    googleAuthCallback,
    githubAuthRedirect,
    githubAuthCallback
};