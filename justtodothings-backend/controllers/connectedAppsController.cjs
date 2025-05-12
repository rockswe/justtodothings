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
    console.log("[connectCanvas] Received event:", JSON.stringify(event, null, 2));
    // 1. Ensure user is authenticated
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectCanvas] Unauthorized: User ID not found.");
      return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectCanvas] Authenticated User ID:", userId);
  
    // 2. Parse the request body
    const data = JSON.parse(event.body || "{}");
    console.log("[connectCanvas] Parsed request data:", data);
    const { domain, accessToken } = data; 
    if (!domain || !accessToken) {
      console.error("[connectCanvas] Missing domain or accessToken in request.");
      return buildResponse(400, { message: "Canvas domain and accessToken are required." });
    }
  
    // 3. Test the token by calling /api/v1/users/self
    const testUrl = `https://${domain}/api/v1/users/self`;
    let canvasUserId;
    try {
      console.log("[connectCanvas] Testing Canvas token with URL:", testUrl);
      const headers = { Authorization: `Bearer ${accessToken}` };
      const res = await axios.get(testUrl, { headers });
      if (!res.data || !res.data.id) {
        console.error("[connectCanvas] Canvas token test failed: 'id' not found in response.", res.data);
        return buildResponse(400, { message: "Canvas token test failed. 'id' not found in response." });
      }
      // Extract Canvas user id from the response
      canvasUserId = res.data.id;
      console.log("[connectCanvas] Canvas token test successful. Canvas User ID:", canvasUserId);
    } catch (err) {
      console.error("[connectCanvas] Error testing token:", err.response?.data || err.message, err);
      return buildResponse(400, { message: "Invalid Canvas domain or access token." });
    }
  
    // 4. Check if this Canvas account is already connected to another user.
    const client = await pool.connect();
    try {
      console.log("[connectCanvas] Checking for existing Canvas connection for canvasUserId:", canvasUserId, "excluding current userId:", userId);
      const checkQuery = `
        SELECT id 
        FROM users
        WHERE connected_apps->'canvas'->>'canvasUserId' = $1
          AND id <> $2
      `;
      const checkResult = await client.query(checkQuery, [String(canvasUserId), userId]);
      if (checkResult.rows.length > 0) {
        console.warn("[connectCanvas] This Canvas account (canvasUserId:", canvasUserId, ") is already connected to another user (user ID:", checkResult.rows[0].id, ").");
        return buildResponse(400, { message: "This Canvas account is already connected to another user." });
      }
    
      // 5. Store the Canvas connection data in connected_apps->'canvas'
      const storeObject = { canvasUserId, domain, accessToken };
      console.log("[connectCanvas] Storing Canvas connection for userId:", userId, "Data:", storeObject);
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
      console.log("[connectCanvas] Canvas integration connected successfully for userId:", userId, "Updated connected_apps:", result.rows[0].connected_apps);
      return buildResponse(200, {
        message: "Canvas integration connected successfully.",
        connected_apps: result.rows[0].connected_apps,
      });
    } catch (err) {
      console.error("[connectCanvas] DB Error for userId:", userId, "Error:", err);
      return buildResponse(500, { message: "Internal server error while connecting Canvas." });
    } finally {
      client.release();
    }
  }  

  // DELETE /connected-apps/canvas Disconnect Canvas integration
async function disconnectCanvas(event) {
  console.log("[disconnectCanvas] Received event:", JSON.stringify(event, null, 2));
  const userId = await getUserIdFromToken(event);
  if (!userId) {
    console.error("[disconnectCanvas] Unauthorized: User ID not found.");
    return buildResponse(401, { message: "Unauthorized" });
  }
  console.log("[disconnectCanvas] Authenticated User ID:", userId);

  const client = await pool.connect();
  try {
    console.log("[disconnectCanvas] Attempting to disconnect Canvas for userId:", userId);
    // Remove the 'canvas' key from connected_apps JSONB column
    const query = `
      UPDATE users
      SET connected_apps = connected_apps - 'canvas'
      WHERE id = $1
      RETURNING connected_apps
    `;
    const result = await client.query(query, [userId]);
    console.log("[disconnectCanvas] Canvas integration disconnected successfully for userId:", userId, "Updated connected_apps:", result.rows[0].connected_apps);
    return buildResponse(200, { message: "Canvas integration disconnected.", connected_apps: result.rows[0].connected_apps });
  } catch (err) {
    console.error("[disconnectCanvas] Error for userId:", userId, "Error:", err);
    return buildResponse(500, { message: "Internal server error." });
  } finally {
    client.release();
  }
}

// --- Gmail --- 
// New: Redirect handler for initiating Gmail OAuth
async function connectGmailRedirect(event) {
    console.log("[connectGmailRedirect] Received event:", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectGmailRedirect] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectGmailRedirect] Authenticated User ID:", userId);

    const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI 
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
    console.log("[connectGmailRedirect] Generated state for OAuth:", state);

    const authorizationUrl = oauth2Client.generateAuthUrl({
        access_type: "offline", // Request refresh token
        scope: scopes,
        prompt: "consent", // Ensure user sees consent screen even if previously authorized
        state: state
    });
    console.log("[connectGmailRedirect] Generated Gmail authorization URL for userId:", userId, "URL:", authorizationUrl);

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
    console.log("[connectGmail] Received event (callback):", JSON.stringify(event, null, 2));
    // 1. Authenticate user via JWT
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectGmail] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectGmail] Authenticated User ID:", userId);
  
    // 2. Get the OAuth code and state from the query string
    const query = event.queryStringParameters || {};
    console.log("[connectGmail] Query parameters:", query);
    const { code, state: returnedState } = query; // <-- Extract state
  
    // --- Minimal State Validation ---
    let cookieHeaderString = event.headers.Cookie || event.headers.cookie; // Standard way
    if (!cookieHeaderString && event.cookies && Array.isArray(event.cookies)) {
        console.log("[connectGmail] Cookie string not found in headers, attempting to use event.cookies array.");
        if (event.cookies.length > 0) {
            cookieHeaderString = event.cookies.join('; '); // Reconstruct from array
            console.log("[connectGmail] Reconstructed cookie string:", cookieHeaderString);
        } else {
            console.log("[connectGmail] event.cookies array is empty.");
        }
    } else if (cookieHeaderString) {
        console.log("[connectGmail] Found cookie string in headers:", cookieHeaderString);
    } else {
        console.log("[connectGmail] No cookie information found in headers or event.cookies array.");
    }

    const cookies = parseCookies(cookieHeaderString || ""); // Pass reconstructed or original string, or empty string
    console.log("[connectGmail] Parsed cookies:", cookies);
    const expectedState = cookies.oauth_state; // <-- Get state from cookie
    console.log("[connectGmail] Returned state:", returnedState, "Expected state (from cookie):", expectedState);
  
    // Define header to clear the state cookie (needed in all response paths)
    const clearStateCookieHeader = { "Set-Cookie": "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" };
    const frontendRedirectBaseUrl = process.env.APP_FRONTEND_URL || "https://www.justtodothings.com";

    if (!returnedState || !expectedState || returnedState !== expectedState) {
      console.error("[connectGmail] State mismatch error. Potential CSRF.", { returnedState, expectedState, userId });
      // Return error and clear the cookie
      const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=error&message=STATE_MISMATCH`;
      return {
        statusCode: 302,
        headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
        body: "",
      };
    }
    console.log("[connectGmail] State validation successful for userId:", userId);
    // --- End State Validation ---
  
  
    if (!code) {
      console.error("[connectGmail] Missing 'code' parameter in query for userId:", userId);
      const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=error&message=MISSING_CODE`;
      return {
        statusCode: 302,
        headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
        body: "",
      };
    }
    console.log("[connectGmail] Received OAuth code for userId:", userId, "Code:", code.substring(0, 20) + "..."); // Log only part of the code
  
    // 3. Create an OAuth2 client for Gmail using environment variables
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,    // Corrected to GMAIL_CLIENT_ID
      process.env.GMAIL_CLIENT_SECRET,  // Corrected to GMAIL_CLIENT_SECRET
      process.env.GMAIL_REDIRECT_URI    // Corrected to GMAIL_REDIRECT_URI
    );


    try {
      console.log("[connectGmail] Attempting to exchange code for tokens for userId:", userId);
      // Exchange the code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      console.log("[connectGmail] Successfully exchanged code for tokens for userId:", userId, "Tokens received (expiry_date):", tokens.expiry_date, "Refresh token present:", !!tokens.refresh_token);
  
      // 4. Validate the token by fetching the user's Gmail profile
      console.log("[connectGmail] Fetching Gmail profile for userId:", userId);
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const profileRes = await gmail.users.getProfile({ userId: "me" });
      if (!profileRes.data || !profileRes.data.emailAddress) {
        console.error("[connectGmail] Gmail token test failed: emailAddress not found in profile response for userId:", userId, "Response data:", profileRes.data);
        // Clear cookie on error
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=error&message=GMAIL_PROFILE_FETCH_FAILED`;
        return {
          statusCode: 302,
          headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
          body: "",
        };
      }
      const gmailEmail = profileRes.data.emailAddress;
      console.log("[connectGmail] Successfully fetched Gmail profile for userId:", userId, "Email:", gmailEmail);
  
      // 5. Prepare Gmail token data for storage
      const gmailData = {
        email: gmailEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date
      };
      console.log("[connectGmail] Prepared Gmail data for storage for userId:", userId, "Data (excluding tokens):", { email: gmailEmail, expiryDate: tokens.expiry_date });
  
      // 6. Update the user's connected_apps JSON in the database
      const client = await pool.connect();
      try {
        console.log("[connectGmail] Checking for duplicate Gmail connection for email:", gmailEmail, "excluding current userId:", userId);
        // Check for duplicate connection
        const duplicateCheckQuery = `
          SELECT id
          FROM users
          WHERE connected_apps->'gmail'->>'email' = $1
            AND id <> $2
        `;
        const duplicateResult = await client.query(duplicateCheckQuery, [gmailEmail, userId]);
        if (duplicateResult.rows.length > 0) {
          console.warn("[connectGmail] This Gmail account (email:", gmailEmail, ") is already connected to another user (user ID:", duplicateResult.rows[0].id, ").");
          // Clear cookie even if it's a duplicate error
          const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=error&message=GMAIL_ACCOUNT_ALREADY_CONNECTED_TO_ANOTHER_USER`;
          return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
          };
        }
  
        console.log("[connectGmail] Storing Gmail connection for userId:", userId);
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
  
        console.log("[connectGmail] Gmail integration connected successfully for userId:", userId, "Updated connected_apps:", result.rows[0].connected_apps);
        // Return success and clear the state cookie
        const successRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=success`;
        return {
          statusCode: 302,
          headers: { ...clearStateCookieHeader, Location: successRedirectUrl },
          body: "",
        };
  
      } catch (dbErr) {
        console.error("[connectGmail] DB Error for userId:", userId, "Email:", gmailEmail, "Error:", dbErr);
        // Clear cookie on DB error
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=error&message=DB_ERROR_CONNECTING_GMAIL`;
        return {
          statusCode: 302,
          headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
          body: "",
        };
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[connectGmail] Error exchanging code or fetching profile for userId:", userId, "Error Details:", err.response?.data || err.message, err);
      // Clear cookie on API/token errors
      const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=gmail&status=error&message=GMAIL_CODE_EXCHANGE_OR_PROFILE_ERROR`;
      return {
        statusCode: 302,
        headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
        body: "",
      };
    }
  }

// DELETE /connected-apps/gmail Disconnect Gmail integration
async function disconnectGmail(event) {
  console.log("[disconnectGmail] Received event:", JSON.stringify(event, null, 2));
  const userId = await getUserIdFromToken(event);
  if (!userId) {
    console.error("[disconnectGmail] Unauthorized: User ID not found.");
    return buildResponse(401, { message: "Unauthorized" });
  }
  console.log("[disconnectGmail] Authenticated User ID:", userId);

  const client = await pool.connect();
  try {
    console.log("[disconnectGmail] Attempting to disconnect Gmail for userId:", userId);
    // Remove the 'gmail' key from connected_apps JSONB column
    const query = `
      UPDATE users
      SET connected_apps = connected_apps - 'gmail'
      WHERE id = $1
      RETURNING connected_apps
    `;
    const result = await client.query(query, [userId]);
    console.log("[disconnectGmail] Gmail integration disconnected successfully for userId:", userId, "Updated connected_apps:", result.rows[0].connected_apps);
    return buildResponse(200, { message: "Gmail integration disconnected.", connected_apps: result.rows[0].connected_apps });
  } catch (err) {
    console.error("[disconnectGmail] Error for userId:", userId, "Error:", err);
    return buildResponse(500, { message: "Internal server error." });
  } finally {
    client.release();
  }
}

// --- GitHub --- 
async function connectGitHubRedirect(event) { // New redirect handler for GitHub
    console.log("[connectGitHubRedirect] Received event:", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectGitHubRedirect] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectGitHubRedirect] Authenticated User ID:", userId);

    const state = crypto.randomBytes(16).toString('hex');
    const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
    console.log("[connectGitHubRedirect] Generated state for OAuth:", state, "for userId:", userId);

    const params = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID,
        redirect_uri: process.env.GITHUB_APP_CONNECT_REDIRECT_URI,
        scope: "repo user:email", // Requested scopes: repo for private repo access, user:email for email
        state: state,
    });
    const authorizationUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    console.log("[connectGitHubRedirect] Generated GitHub authorization URL for userId:", userId, "URL:", authorizationUrl);
    console.log("[connectGitHubRedirect] Redirecting userId:", userId, "to GitHub for authorization.");
    return {
        statusCode: 302,
        headers: { Location: authorizationUrl, "Set-Cookie": stateCookie },
        body: ""
    };
}

async function connectGitHub(event) {
    console.log("[connectGitHub] Received event (callback):", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
        console.error("[connectGitHub] Unauthorized: User ID not found.");
        return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectGitHub] Authenticated User ID:", userId);

    const query = event.queryStringParameters || {};
    console.log("[connectGitHub] Query parameters for userId:", userId, ":", query);
    const { code, state: returnedState } = query;

    // --- Cookie parsing logic for state validation ---
    let cookieHeaderString = event.headers.Cookie || event.headers.cookie; 
    if (!cookieHeaderString && event.cookies && Array.isArray(event.cookies)) {
        console.log("[connectGitHub] Cookie string not found in headers for userId:", userId, ", attempting to use event.cookies array.");
        if (event.cookies.length > 0) {
            cookieHeaderString = event.cookies.join('; '); 
            console.log("[connectGitHub] Reconstructed cookie string for userId:", userId, ":", cookieHeaderString);
        } else {
            console.log("[connectGitHub] event.cookies array is empty for userId:", userId);
        }
    } else if (cookieHeaderString) {
        console.log("[connectGitHub] Found cookie string in headers for userId:", userId, ":", cookieHeaderString);
    } else {
        console.log("[connectGitHub] No cookie information found in headers or event.cookies array for userId:", userId);
    }
    const cookies = parseCookies(cookieHeaderString || "");
    // --- End cookie parsing logic ---

    console.log("[connectGitHub] Parsed cookies for userId:", userId, ":", cookies);
    const expectedState = cookies.oauth_state;
    console.log("[connectGitHub] Returned state for userId:", userId, ":", returnedState, "Expected state (from cookie):", expectedState);

    const clearStateCookieHeader = { "Set-Cookie": "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" };
    const frontendRedirectBaseUrl = process.env.APP_FRONTEND_URL || "https://www.justtodothings.com";

    if (!returnedState || !expectedState || returnedState !== expectedState) {
        console.error("[connectGitHub] State mismatch for userId:", userId, ". Returned:", returnedState, "Expected:", expectedState, ". Potential CSRF attack.");
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=error&message=STATE_MISMATCH`;
        return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
        };
    }
    console.log("[connectGitHub] State validation successful for userId:", userId);
    if (!code) {
        console.error("[connectGitHub] Missing 'code' parameter in query for userId:", userId);
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=error&message=MISSING_CODE`;
        return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
        };
    }
    console.log("[connectGitHub] Received OAuth code for userId:", userId, ". Code (partial):", code.substring(0,10) + "...");


    try {
        console.log("[connectGitHub] Attempting to exchange GitHub OAuth code for access token for userId:", userId);
        const tokenResponse = await axios.post("https://github.com/login/oauth/access_token", {
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.GITHUB_APP_CONNECT_REDIRECT_URI,
        }, { headers: { Accept: "application/json" } });

        console.log("[connectGitHub] GitHub token exchange response data for userId:", userId, ":", tokenResponse.data);
        const accessToken = tokenResponse.data.access_token;
        if (!accessToken) {
            console.error("[connectGitHub] Access token not found in GitHub response for userId:", userId, ". Response data:", tokenResponse.data);
            const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=error&message=GITHUB_ACCESS_TOKEN_FETCH_FAILED`;
            return {
                statusCode: 302,
                headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
                body: "",
            };
        }
        console.log("[connectGitHub] Successfully retrieved GitHub access token for userId:", userId, ". Token (partial):", accessToken.substring(0,8) + "...");

        console.log("[connectGitHub] Fetching GitHub user profile using access token for userId:", userId);
        const userProfileResponse = await axios.get("https://api.github.com/user", {
            headers: { Authorization: `token ${accessToken}` }
        });
        const { id: githubUserId, login: githubUserLogin } = userProfileResponse.data;
        console.log("[connectGitHub] Successfully fetched GitHub user profile for userId:", userId, ". GitHub User ID:", githubUserId, "Login:", githubUserLogin);

        const client = await pool.connect();
        try {
            console.log("[connectGitHub] Checking for existing GitHub connection for githubUserId:", githubUserId, "(current JTD userId:", userId, ")");
            const duplicateCheckQuery = "SELECT id FROM users WHERE connected_apps->'github'->>'id' = $1 AND id <> $2";
            console.log("[connectGitHub] Executing duplicate check query for userId:", userId, "Query:", duplicateCheckQuery, "Params:", [String(githubUserId), userId]);
            const duplicateCheck = await client.query(duplicateCheckQuery, [String(githubUserId), userId]);

            if (duplicateCheck.rows.length > 0) {
                console.warn("[connectGitHub] Duplicate GitHub account found for userId:", userId, ". GitHub User ID:", githubUserId, "is already connected to JTD user ID:", duplicateCheck.rows[0].id);
                const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=error&message=GITHUB_ACCOUNT_ALREADY_CONNECTED_TO_ANOTHER_USER`;
                return {
                    statusCode: 302,
                    headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
                    body: "",
                };
            }
            console.log("[connectGitHub] No duplicate GitHub connection found for githubUserId:", githubUserId, "for userId:", userId);

            const githubData = { accessToken, id: githubUserId, login: githubUserLogin };
            console.log("[connectGitHub] Storing GitHub connection data for userId:", userId, ". Data (excluding token):", {id: githubUserId, login: githubUserLogin});
            const updateQuery = "UPDATE users SET connected_apps = jsonb_set(connected_apps, '{github}', $1::jsonb, true) WHERE id = $2 RETURNING connected_apps";
            console.log("[connectGitHub] Executing update query to store GitHub data for userId:", userId, "Query:", updateQuery);
            const updateResult = await client.query(updateQuery, [JSON.stringify(githubData), userId]);
            console.log("[connectGitHub] GitHub connected successfully for userId:", userId, ". Updated connected_apps:", updateResult.rows[0].connected_apps);
            const successRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=success`;
            return {
                statusCode: 302,
                headers: { ...clearStateCookieHeader, Location: successRedirectUrl },
                body: "",
            };
        } catch (dbErr) {
            console.error("[connectGitHub] Database error during GitHub connection for userId:", userId, ". Error:", dbErr);
            const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=error&message=DB_ERROR_CONNECTING_GITHUB`;
            return {
                statusCode: 302,
                headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
                body: "",
            };
        } finally {
            console.log("[connectGitHub] Releasing database client for userId:", userId);
            client.release();
        }
    } catch (error) {
        console.error("[connectGitHub] Error during GitHub OAuth process for userId:", userId, ". Error Type:", error.constructor.name, ". Details:", error.response?.data || error.message, error);
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=github&status=error&message=GITHUB_OAUTH_PROCESS_ERROR`;
        return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
        };
    }
}

async function disconnectGitHub(event) {
    console.log("[disconnectGitHub] Received event:", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
        console.error("[disconnectGitHub] Unauthorized: User ID not found in token/event.");
        return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[disconnectGitHub] Authenticated User ID:", userId);
    const client = await pool.connect();
    try {
        console.log("[disconnectGitHub] Attempting to disconnect GitHub for userId:", userId);
        const query = "UPDATE users SET connected_apps = connected_apps - 'github' WHERE id = $1 RETURNING connected_apps";
        console.log("[disconnectGitHub] Executing query to remove GitHub connection for userId:", userId, "Query:", query);
        const result = await client.query(query, [userId]);

        if (result.rows.length === 0) {
            console.warn("[disconnectGitHub] No user found or no GitHub app was connected for userId:", userId, "while trying to disconnect.");
            // Potentially return a different message if the app wasn't connected, though current behavior is fine.
        } else {
            console.log("[disconnectGitHub] GitHub disconnected successfully for userId:", userId, ". Updated connected_apps:", result.rows[0].connected_apps);
        }
        return buildResponse(200, { message: "GitHub disconnected.", connected_apps: result.rows.length > 0 ? result.rows[0].connected_apps : {} });
    } catch (err) {
        console.error("[disconnectGitHub] Database error for userId:", userId, "while disconnecting GitHub. Error:", err);
        return buildResponse(500, { message: "Internal server error." });
    } finally {
        console.log("[disconnectGitHub] Releasing database client for userId:", userId);
        client.release();
    }
}

// --- Slack --- 
async function connectSlackRedirect(event) { // New redirect handler for Slack
    console.log("[connectSlackRedirect] Received event:", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      console.error("[connectSlackRedirect] Unauthorized: User ID not found in token/event.");
      return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectSlackRedirect] Authenticated User ID:", userId);

    const state = crypto.randomBytes(16).toString('hex');
    const stateCookie = `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
    console.log("[connectSlackRedirect] Generated state for OAuth:", state);
    const scopes = [
        // Read scopes (existing)
        "channels:history", "groups:history", "mpim:history", "im:history",
        "channels:read", "groups:read", "im:read", "mpim:read",
        "users:read", "users:read.email",

        // Write scopes (NEW - choose what you need)
        "chat:write",       // Essential for most bot posting
        "commands",         // If you plan to use slash commands
        "im:write"          // If your bot will DM users
        // Add others as needed: groups:write, mpim:write, chat:write.customize
    ].join(",");
    const params = new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        scope: scopes,
        user_scope: "", // If you need user-specific scopes beyond what bot has, list them here, otherwise can be empty for bot token flow
        redirect_uri: process.env.SLACK_REDIRECT_URI,
        state: state,
    });
    const authorizationUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
    console.log("[connectSlackRedirect] Generated Slack authorization URL for userId:", userId, "URL:", authorizationUrl);

    return {
        statusCode: 302,
        headers: { Location: authorizationUrl, "Set-Cookie": stateCookie },
        body: ""
    };
}

async function connectSlack(event) {
    console.log("[connectSlack] Received event (callback):", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
        console.error("[connectSlack] Unauthorized: User ID not found.");
        return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[connectSlack] Authenticated User ID:", userId);

    const query = event.queryStringParameters || {};
    console.log("[connectSlack] Query parameters:", query);
    const { code, state: returnedState } = query;

    // --- Cookie parsing logic for state validation ---
    let cookieHeaderString = event.headers.Cookie || event.headers.cookie; // Standard way
    if (!cookieHeaderString && event.cookies && Array.isArray(event.cookies)) {
        console.log("[connectSlack] Cookie string not found in headers, attempting to use event.cookies array.");
        if (event.cookies.length > 0) {
            cookieHeaderString = event.cookies.join('; '); // Reconstruct from array
            console.log("[connectSlack] Reconstructed cookie string:", cookieHeaderString);
        } else {
            console.log("[connectSlack] event.cookies array is empty.");
        }
    } else if (cookieHeaderString) {
        console.log("[connectSlack] Found cookie string in headers:", cookieHeaderString);
    } else {
        console.log("[connectSlack] No cookie information found in headers or event.cookies array.");
    }
    const cookies = parseCookies(cookieHeaderString || ""); // Pass reconstructed or original string, or empty string
    // --- End cookie parsing logic ---

    console.log("[connectSlack] Parsed cookies:", cookies);
    const expectedState = cookies.oauth_state;
    const clearStateCookieHeader = { "Set-Cookie": "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" };
    const frontendRedirectBaseUrl = process.env.APP_FRONTEND_URL || "https://www.justtodothings.com";
    console.log("[connectSlack] Returned state:", returnedState, "Expected state (from cookie):", expectedState);


    if (!returnedState || !expectedState || returnedState !== expectedState) {
        console.error("[connectSlack] State mismatch for userId:", userId, { returnedState, expectedState });
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=error&message=STATE_MISMATCH`;
        return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
        };
    }
    console.log("[connectSlack] State validation successful for userId:", userId);
    if (!code) {
        console.error("[connectSlack] Missing 'code' parameter in query for userId:", userId);
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=error&message=MISSING_CODE`;
        return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
        };
    }
    console.log("[connectSlack] Received OAuth code for userId:", userId, "Code:", code.substring(0,20) + "...");


    const slackClient = new WebClient();
    try {
        console.log("[connectSlack] Attempting Slack OAuth v2 access for userId:", userId);
        const oauthResponse = await slackClient.oauth.v2.access({
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.SLACK_REDIRECT_URI
        });

        console.log("[connectSlack] Slack OAuth response for userId:", userId, JSON.stringify(oauthResponse, null, 2));

        if (!oauthResponse.ok || !oauthResponse.access_token) {
            console.error("[connectSlack] Slack OAuth failed or access token missing for userId:", userId, "Response:", oauthResponse);
            const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=error&message=SLACK_OAUTH_FAILED_OR_TOKEN_MISSING`;
            return {
                statusCode: 302,
                headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
                body: "",
            };
        }
        console.log("[connectSlack] Slack OAuth successful for userId:", userId, "Access token starts with:", oauthResponse.access_token.substring(0,8) + "...");

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
        console.log("[connectSlack] Extracted Slack connection details for userId:", userId, { team_id, app_id, bot_user_id, authed_user_id: authed_user?.id, slack_user_id_for_connection});


        if (!team_id) {
            console.error("[connectSlack] Slack OAuth response missing team ID for userId:", userId, "Response:", oauthResponse);
            const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=error&message=SLACK_TEAM_ID_MISSING`;
            return {
                statusCode: 302,
                headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
                body: "",
            };
        }

        const client = await pool.connect();
        try {
            console.log("[connectSlack] Checking for duplicate Slack connection for userId:", userId, "Team ID:", team_id, "Slack User/Bot ID for connection:", slack_user_id_for_connection);
            // Check if this specific Slack user (bot or human) in this specific team is already connected to another JTD user.
            const duplicateCheckQuery = `
                SELECT id FROM users 
                WHERE connected_apps->'slack'->>'team_id' = $1 
                  AND connected_apps->'slack'->>'user_id_for_connection' = $2
                  AND id <> $3
            `;
            const duplicateResult = await client.query(duplicateCheckQuery, [team_id, slack_user_id_for_connection, userId]);
            if (duplicateResult.rows.length > 0) {
                console.warn("[connectSlack] This Slack account/bot (Team ID:", team_id, ", Slack User/Bot ID:", slack_user_id_for_connection, ") is already connected to another JTD user (ID:", duplicateResult.rows[0].id, ").");
                const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=error&message=SLACK_ACCOUNT_ALREADY_CONNECTED_TO_ANOTHER_USER`;
                return {
                    statusCode: 302,
                    headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
                    body: "",
                };
            }

            const slackData = {
                accessToken,
                team_id: team_id,
                app_id: app_id,
                bot_user_id: bot_user_id, // May be null for user tokens
                user_id: authed_user?.id, // Actual user ID, may be null for bot tokens if authed_user is not present
                user_id_for_connection: slack_user_id_for_connection // Helper field for duplicate checks
            };
            console.log("[connectSlack] Storing Slack connection for userId:", userId, "Data (excluding token):", { team_id, app_id, bot_user_id, user_id: authed_user?.id, slack_user_id_for_connection: slack_user_id_for_connection });


            const updateResult = await client.query(
                "UPDATE users SET connected_apps = jsonb_set(connected_apps, '{slack}', $1::jsonb, true) WHERE id = $2 RETURNING connected_apps",
                [JSON.stringify(slackData), userId]
            );
            console.log("[connectSlack] Slack connected successfully for userId:", userId, "Updated connected_apps:", updateResult.rows[0].connected_apps);
            const successRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=success`;
            return {
                statusCode: 302,
                headers: { ...clearStateCookieHeader, Location: successRedirectUrl },
                body: "",
            };
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("[connectSlack] Error during Slack OAuth process for userId:", userId, "Error details:", error.response?.data || error.data || error.message, error);
        const errorRedirectUrl = `${frontendRedirectBaseUrl}?app=slack&status=error&message=SLACK_OAUTH_PROCESS_ERROR`;
        return {
            statusCode: 302,
            headers: { ...clearStateCookieHeader, Location: errorRedirectUrl },
            body: "",
        };
    }
}

async function disconnectSlack(event) {
    console.log("[disconnectSlack] Received event:", JSON.stringify(event, null, 2));
    const userId = await getUserIdFromToken(event);
    if (!userId) {
        console.error("[disconnectSlack] Unauthorized: User ID not found.");
        return buildResponse(401, { message: "Unauthorized" });
    }
    console.log("[disconnectSlack] Authenticated User ID:", userId);
    const client = await pool.connect();
    try {
        console.log("[disconnectSlack] Attempting to disconnect Slack for userId:", userId);
        const result = await client.query(
            "UPDATE users SET connected_apps = connected_apps - 'slack' WHERE id = $1 RETURNING connected_apps", 
            [userId]
        );
        console.log("[disconnectSlack] Slack disconnected successfully for userId:", userId, "Updated connected_apps:", result.rows[0].connected_apps);
        return buildResponse(200, { message: "Slack disconnected.", connected_apps: result.rows[0].connected_apps });
    } catch (err) {
        console.error("[disconnectSlack] Error for userId:", userId, "Error:", err);
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