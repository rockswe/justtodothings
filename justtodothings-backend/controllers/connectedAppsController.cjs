"use strict";

const axios = require("axios");
const { google } = require("googleapis");
const { parse } = require("cookie"); // Used by connectGmail for state validation from cookie
const { WebClient } = require("@slack/web-api"); // Added for Slack OAuth
const crypto = require("crypto"); // Added for state generation

const { pool } = require("../config/db.cjs");
const { buildResponse } = require("../utils/responseHelper.cjs");
const { getUserIdFromToken } = require("../services/tokenService.cjs");
const { parseCookies } = require("../utils/cookieHelper.cjs"); // Used by connectGmail

async function connectCanvas(event) {
    // 1. Ensure user is authenticated
    const userId = await getUserIdFromToken(event);
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
  const userId = await getUserIdFromToken(event);
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

// --- Gmail --- 
// New: Redirect handler for initiating Gmail OAuth
async function connectGmailRedirect(event) {
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectGmailRedirect] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }

    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI 
    );

    const scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose"
    ];

    const state = crypto.randomBytes(16).toString('hex');
    const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Domain=.justtodothings.com; Path=/; SameSite=Lax; Max-Age=600`; 
    // Note: Domain attribute for cookies depends on your setup. If frontend and backend are on different subdomains of a common parent, set Domain=.yourparent.com
    // For localhost or same domain, omitting Domain is fine or set to specific domain if needed.

    const authorizationUrl = oauth2Client.generateAuthUrl({
        access_type: "offline", // Request refresh token
        scope: scopes,
        prompt: "consent", // Ensure user sees consent screen even if previously authorized
        state: state
    });

    return {
        statusCode: 302,
        headers: {
            Location: authorizationUrl,
            "Set-Cookie": stateCookie
        },
        body: ""
    };
}

// connectGmail (Callback handler - This function should already exist as per previous steps)
async function connectGmail(event) {
    // 1. Authenticate user via JWT
    const userId = await getUserIdFromToken(event);
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
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI 
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
  const userId = await getUserIdFromToken(event);
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

// --- GitHub --- 
async function connectGitHubRedirect(event) { // New redirect handler for GitHub
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectGitHubRedirect] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }

    const state = crypto.randomBytes(16).toString('hex');
    const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;

    const params = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID,
        redirect_uri: process.env.GITHUB_REDIRECT_URI,
        scope: "repo user:email", // Requested scopes: repo for private repo access, user:email for email
        state: state,
    });
    const authorizationUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    return {
        statusCode: 302,
        headers: { Location: authorizationUrl, "Set-Cookie": stateCookie },
        body: ""
    };
}

async function connectGitHub(event) {
    const userId = await getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });

    const query = event.queryStringParameters || {};
    const { code, state: returnedState } = query;
    const cookies = parseCookies(event.headers.Cookie || event.headers.cookie);
    const expectedState = cookies.oauth_state;

    const clearStateCookieHeader = { "Set-Cookie": "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" };

    if (!returnedState || !expectedState || returnedState !== expectedState) {
        console.error("[connectGitHub] State mismatch.", { returnedState, expectedState });
        return buildResponse(400, { message: "Invalid state parameter." }, clearStateCookieHeader);
    }
    if (!code) {
        return buildResponse(400, { message: "Missing code parameter." }, clearStateCookieHeader);
    }

    try {
        const tokenResponse = await axios.post("https://github.com/login/oauth/access_token", {
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.GITHUB_REDIRECT_URI,
        }, { headers: { Accept: "application/json" } });

        const accessToken = tokenResponse.data.access_token;
        if (!accessToken) {
            console.error("[connectGitHub] Access token not found in GitHub response", tokenResponse.data);
            return buildResponse(400, { message: "Failed to retrieve GitHub access token." }, clearStateCookieHeader);
        }

        const userProfileResponse = await axios.get("https://api.github.com/user", {
            headers: { Authorization: `token ${accessToken}` }
        });
        const { id: githubUserId, login: githubUserLogin } = userProfileResponse.data;

        const client = await pool.connect();
        try {
            const duplicateCheck = await client.query(
                "SELECT id FROM users WHERE connected_apps->'github'->>'id' = $1 AND id <> $2", 
                [String(githubUserId), userId]
            );
            if (duplicateCheck.rows.length > 0) {
                return buildResponse(400, { message: "This GitHub account is already connected to another user." }, clearStateCookieHeader);
            }

            const githubData = { accessToken, id: githubUserId, login: githubUserLogin };
            const updateResult = await client.query(
                "UPDATE users SET connected_apps = jsonb_set(connected_apps, '{github}', $1::jsonb, true) WHERE id = $2 RETURNING connected_apps",
                [JSON.stringify(githubData), userId]
            );
            return buildResponse(200, { message: "GitHub connected successfully.", connected_apps: updateResult.rows[0].connected_apps }, clearStateCookieHeader);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("[connectGitHub] Error:", error.response?.data || error.message);
        return buildResponse(500, { message: "Error connecting GitHub account." }, clearStateCookieHeader);
    }
}

async function disconnectGitHub(event) {
    const userId = await getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
    const client = await pool.connect();
    try {
        const result = await client.query(
            "UPDATE users SET connected_apps = connected_apps - 'github' WHERE id = $1 RETURNING connected_apps", 
            [userId]
        );
        return buildResponse(200, { message: "GitHub disconnected.", connected_apps: result.rows[0].connected_apps });
    } catch (err) {
        console.error("[disconnectGitHub] Error:", err);
        return buildResponse(500, { message: "Internal server error." });
    } finally {
        client.release();
    }
}

// --- Slack --- 
async function connectSlackRedirect(event) { // New redirect handler for Slack
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectSlackRedirect] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }

    const state = crypto.randomBytes(16).toString('hex');
    const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
    
    // Define scopes needed for Slack sync lambda
    const scopes = [
        "channels:history", "groups:history", "mpim:history", "im:history", // Read messages
        "channels:read", "groups:read", "im:read", "mpim:read",          // List conversations
        "users:read", "users:read.email"                               // User details, team_id often comes with token
    ].join(",");

    const params = new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        scope: scopes,
        user_scope: "", // If you need user-specific scopes beyond what bot has, list them here, otherwise can be empty for bot token flow
        redirect_uri: process.env.SLACK_REDIRECT_URI,
        state: state,
    });
    const authorizationUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

    return {
        statusCode: 302,
        headers: { Location: authorizationUrl, "Set-Cookie": stateCookie },
        body: ""
    };
}

async function connectSlack(event) {
    const userId = await getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });

    const query = event.queryStringParameters || {};
    const { code, state: returnedState } = query;
    const cookies = parseCookies(event.headers.Cookie || event.headers.cookie);
    const expectedState = cookies.oauth_state;
    const clearStateCookieHeader = { "Set-Cookie": "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" };

    if (!returnedState || !expectedState || returnedState !== expectedState) {
        console.error("[connectSlack] State mismatch.", { returnedState, expectedState });
        return buildResponse(400, { message: "Invalid state parameter." }, clearStateCookieHeader);
    }
    if (!code) {
        return buildResponse(400, { message: "Missing code parameter." }, clearStateCookieHeader);
    }

    const slackClient = new WebClient();
    try {
        const oauthResponse = await slackClient.oauth.v2.access({
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.SLACK_REDIRECT_URI
        });

        if (!oauthResponse.ok || !oauthResponse.access_token) {
            console.error("[connectSlack] Slack OAuth failed or access token missing", oauthResponse);
            return buildResponse(400, { message: `Slack connection failed: ${oauthResponse.error || 'Unknown reason'}` }, clearStateCookieHeader);
        }

        const { 
            access_token: accessToken,
            team,
            app_id,
            bot_user_id,
            authed_user 
        } = oauthResponse;
        
        const team_id = team?.id;
        // Use authed_user.id if present (user token flow), otherwise bot_user_id (bot token flow)
        const slack_user_id_for_connection = authed_user?.id || bot_user_id;

        if (!team_id) {
            console.error("[connectSlack] Slack OAuth response missing team ID.", oauthResponse);
            return buildResponse(400, { message: "Slack connection failed: Team ID not found." }, clearStateCookieHeader);
        }

        const client = await pool.connect();
        try {
            // Check if this specific Slack user (bot or human) in this specific team is already connected to another JTD user.
            const duplicateCheckQuery = `
                SELECT id FROM users 
                WHERE connected_apps->'slack'->>'team_id' = $1 
                  AND connected_apps->'slack'->>'user_id_for_connection' = $2
                  AND id <> $3
            `;
            const duplicateResult = await client.query(duplicateCheckQuery, [team_id, slack_user_id_for_connection, userId]);
            if (duplicateResult.rows.length > 0) {
                return buildResponse(400, { message: "This Slack account/bot in this workspace is already connected to another user." }, clearStateCookieHeader);
            }

            const slackData = {
                accessToken,
                team_id: team_id,
                app_id: app_id,
                bot_user_id: bot_user_id, // May be null for user tokens
                user_id: authed_user?.id, // Actual user ID, may be null for bot tokens if authed_user is not present
                user_id_for_connection: slack_user_id_for_connection // Helper field for duplicate checks
            };

            const updateResult = await client.query(
                "UPDATE users SET connected_apps = jsonb_set(connected_apps, '{slack}', $1::jsonb, true) WHERE id = $2 RETURNING connected_apps",
                [JSON.stringify(slackData), userId]
            );
            return buildResponse(200, { message: "Slack connected successfully.", connected_apps: updateResult.rows[0].connected_apps }, clearStateCookieHeader);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("[connectSlack] Error:", error.response?.data || error.data || error.message, error);
        return buildResponse(500, { message: "Error connecting Slack account." }, clearStateCookieHeader);
    }
}

async function disconnectSlack(event) {
    const userId = await getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
    const client = await pool.connect();
    try {
        const result = await client.query(
            "UPDATE users SET connected_apps = connected_apps - 'slack' WHERE id = $1 RETURNING connected_apps", 
            [userId]
        );
        return buildResponse(200, { message: "Slack disconnected.", connected_apps: result.rows[0].connected_apps });
    } catch (err) {
        console.error("[disconnectSlack] Error:", err);
        return buildResponse(500, { message: "Internal server error." });
    } finally {
        client.release();
    }
}

module.exports = {
    connectCanvas,
    disconnectCanvas,
    connectGmailRedirect, // New
    connectGmail,
    disconnectGmail,
    connectGitHubRedirect, // New
    connectGitHub,      
    disconnectGitHub,   
    connectSlackRedirect,  // New
    connectSlack,       
    disconnectSlack     
};