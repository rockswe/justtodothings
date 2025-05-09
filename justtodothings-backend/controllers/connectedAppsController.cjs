"use strict";

const axios = require("axios");
const { google } = require("googleapis");
const { parse } = require("cookie"); // Used by connectGmail for state validation from cookie

const { pool } = require("../config/db.cjs");
const { buildResponse } = require("../utils/responseHelper.cjs");
const { getUserIdFromToken } = require("../services/tokenService.cjs");
const { parseCookies } = require("../utils/cookieHelper.cjs"); // Used by connectGmail

async function connectCanvas(event) {
    // 1. Ensure user is authenticated
    const userId = getUserIdFromToken(event);
    if (!userId) {
      return buildResponse(401, { message: "Unauthorized" });
    }
  
    // 2. Parse the request body
    const data = JSON.parse(event.body || "{}");
    const { domain, accessToken } = data; 
    if (!domain || !accessToken) {
      return buildResponse(400, { message: "Canvas domain and accessToken are required." });
    }
  
    // 3. Test the token by calling /api/v1/users/self
    const testUrl = `https://${domain}/api/v1/users/self`;
    let canvasUserId;
    try {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const res = await axios.get(testUrl, { headers });
      if (!res.data || !res.data.id) {
        return buildResponse(400, { message: "Canvas token test failed. 'id' not found in response." });
      }
      // Extract Canvas user id from the response
      canvasUserId = res.data.id;
    } catch (err) {
      console.error("[connectCanvas] Error testing token:", err.response?.data || err.message);
      return buildResponse(400, { message: "Invalid Canvas domain or access token." });
    }
  
    // 4. Check if this Canvas account is already connected to another user.
    const client = await pool.connect();
    try {
      const checkQuery = `
        SELECT id 
        FROM users
        WHERE connected_apps->'canvas'->>'canvasUserId' = $1
          AND id <> $2
      `;
      const checkResult = await client.query(checkQuery, [String(canvasUserId), userId]);
      if (checkResult.rows.length > 0) {
        return buildResponse(400, { message: "This Canvas account is already connected to another user." });
      }
    
      // 5. Store the Canvas connection data in connected_apps->'canvas'
      const storeObject = { canvasUserId, domain, accessToken };
      const updateQuery = `
        UPDATE users
        SET connected_apps = jsonb_set(
            connected_apps,
            '{canvas}',
            $1::jsonb,
            true
        )
        WHERE id = $2
        RETURNING connected_apps
      `;
      // Here, we convert storeObject to a JSON string.
      const result = await client.query(updateQuery, [JSON.stringify(storeObject), userId]);
      return buildResponse(200, {
        message: "Canvas integration connected successfully.",
        connected_apps: result.rows[0].connected_apps,
      });
    } catch (err) {
      console.error("[connectCanvas] DB Error:", err);
      return buildResponse(500, { message: "Internal server error while connecting Canvas." });
    } finally {
      client.release();
    }
  }  

  // DELETE /connected-apps/canvas Disconnect Canvas integration
async function disconnectCanvas(event) {
  const userId = getUserIdFromToken(event);
  if (!userId) {
    return buildResponse(401, { message: "Unauthorized" });
  }

  const client = await pool.connect();
  try {
    // Remove the 'canvas' key from connected_apps JSONB column
    const query = `
      UPDATE users
      SET connected_apps = connected_apps - 'canvas'
      WHERE id = $1
      RETURNING connected_apps
    `;
    const result = await client.query(query, [userId]);
    return buildResponse(200, { message: "Canvas integration disconnected.", connected_apps: result.rows[0].connected_apps });
  } catch (err) {
    console.error("[disconnectCanvas] Error:", err);
    return buildResponse(500, { message: "Internal server error." });
  } finally {
    client.release();
  }
}

async function connectGmail(event) {
    // 1. Authenticate user via JWT
    const userId = getUserIdFromToken(event);
    if (!userId) {
      return buildResponse(401, { message: "Unauthorized" });
    }
  
    // 2. Get the OAuth code and state from the query string
    const query = event.queryStringParameters || {};
    const { code, state: returnedState } = query; // <-- Extract state
  
    // --- Minimal State Validation ---
    const cookies = parseCookies(event.headers.Cookie || event.headers.cookie); // Uses helper from cookieHelper.js
    const expectedState = cookies.oauth_state; // <-- Get state from cookie
  
    // Define header to clear the state cookie (needed in all response paths)
    const clearStateCookieHeader = { "Set-Cookie": "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" };
  
    if (!returnedState || !expectedState || returnedState !== expectedState) {
      console.error("[connectGmail] State mismatch error. Potential CSRF.", { returnedState, expectedState });
      // Return error and clear the cookie
      return buildResponse(400, { message: "Invalid state parameter. Please try connecting again." }, clearStateCookieHeader);
    }
    // --- End State Validation ---
  
  
    if (!code) {
      // State was ok, but code is missing
      return buildResponse(400, { message: "Missing code parameter." }, clearStateCookieHeader); // <-- Clear cookie
    }
  
    // 3. Create an OAuth2 client for Gmail using environment variables
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
  
    try {
      // Exchange the code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
  
      // 4. Validate the token by fetching the user's Gmail profile
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const profileRes = await gmail.users.getProfile({ userId: "me" });
      if (!profileRes.data || !profileRes.data.emailAddress) {
        // Clear cookie on error
        return buildResponse(400, { message: "Gmail token test failed: emailAddress not found." }, clearStateCookieHeader);
      }
      const gmailEmail = profileRes.data.emailAddress;
  
      // 5. Prepare Gmail token data for storage
      const gmailData = {
        email: gmailEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date
      };
  
      // 6. Update the user's connected_apps JSON in the database
      const client = await pool.connect();
      try {
        // Check for duplicate connection
        const duplicateCheckQuery = `
          SELECT id
          FROM users
          WHERE connected_apps->'gmail'->>'email' = $1
            AND id <> $2
        `;
        const duplicateResult = await client.query(duplicateCheckQuery, [gmailEmail, userId]);
        if (duplicateResult.rows.length > 0) {
          // Clear cookie even if it's a duplicate error
          return buildResponse(400, { message: "This Gmail account is already connected to another user." }, clearStateCookieHeader);
        }
  
        // Store connection data
        const updateQuery = `
          UPDATE users
          SET connected_apps = jsonb_set(
              connected_apps,
              '{gmail}',
              to_jsonb($1::text)::jsonb,
              true
            )
          WHERE id = $2
          RETURNING connected_apps
        `;
        const result = await client.query(updateQuery, [JSON.stringify(gmailData), userId]);
  
        // Return success and clear the state cookie
        return buildResponse(200, {
          message: "Gmail integration connected successfully.",
          connected_apps: result.rows[0].connected_apps
        }, clearStateCookieHeader); // <-- Clear cookie
  
      } catch (dbErr) {
        console.error("[connectGmail] DB Error:", dbErr);
        // Clear cookie on DB error
        return buildResponse(500, { message: "Internal server error while connecting Gmail." }, clearStateCookieHeader);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[connectGmail] Error exchanging code or fetching profile:", err.response?.data || err.message);
      // Clear cookie on API/token errors
      return buildResponse(400, { message: "Invalid Gmail code or tokens." }, clearStateCookieHeader);
    }
  }

// DELETE /connected-apps/gmail Disconnect Gmail integration
async function disconnectGmail(event) {
  const userId = getUserIdFromToken(event);
  if (!userId) {
    return buildResponse(401, { message: "Unauthorized" });
  }

  const client = await pool.connect();
  try {
    // Remove the 'gmail' key from connected_apps JSONB column
    const query = `
      UPDATE users
      SET connected_apps = connected_apps - 'gmail'
      WHERE id = $1
      RETURNING connected_apps
    `;
    const result = await client.query(query, [userId]);
    return buildResponse(200, { message: "Gmail integration disconnected.", connected_apps: result.rows[0].connected_apps });
  } catch (err) {
    console.error("[disconnectGmail] Error:", err);
    return buildResponse(500, { message: "Internal server error." });
  } finally {
    client.release();
  }
}

module.exports = {
    connectCanvas,
    disconnectCanvas,
    connectGmail,
    disconnectGmail
};