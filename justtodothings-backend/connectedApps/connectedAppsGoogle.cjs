"use strict";

// MODIFIED: Use AWS SDK v3 for S3
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3"); // Added GetObjectCommand just in case, though not used in final code for this request
const { Pool } = require("pg");
const { google } = require("googleapis");

// Environment variables:
//   DATABASE_URL
//   S3_RAW_BUCKET
//   GMAIL_CLIENT_ID
//   GMAIL_CLIENT_SECRET
//   (GMAIL_REDIRECT_URI is used by connectGmail in controller, but not strictly here if oauth2Client is for refresh)

// MODIFIED: S3 client instantiation for v3
const s3 = new S3Client({});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---------- Gmail Data Fetching (Modified for full content and token refresh) ----------
async function fetchGmailData(userId, gmailCreds, dbClient) { // ADDED: dbClient for token updates
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
    // GMAIL_REDIRECT_URI is not strictly required for server-side token refresh if refresh_token is present
  );
  oauth2Client.setCredentials({
    access_token: gmailCreds.accessToken,
    refresh_token: gmailCreds.refreshToken,
  });

  let newAccessToken; // To store new token if refreshed
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      console.log(`[GmailSync] User ${userId}: New access token received.`);
      newAccessToken = tokens.access_token;
    }
    // Optional: Handle new refresh_token if provided by Google
    // if (tokens.refresh_token) {
    //   console.log(`[GmailSync] User ${userId}: New refresh token received.`);
    //   // Logic to store the new refresh_token in the database would go here.
    // }
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Fetch recent messages. Consider making maxResults configurable or using historyId for true delta sync.
  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 20, // Example: fetch last 20 messages. Adjust as needed.
    // q: "is:unread", // Example: to fetch only unread messages.
  });

  // Helper function to update token in DB
  const updateTokenInDb = async (tokenToUpdate) => {
    // Ensure dbClient is valid and token has actually changed
    if (dbClient && gmailCreds.accessToken !== tokenToUpdate) {
      try {
        await dbClient.query(
          `UPDATE users
           SET connected_apps = jsonb_set(connected_apps, '{gmail,accessToken}', $1::jsonb, true)
           WHERE id = $2 AND (connected_apps->'gmail'->>'accessToken' IS NULL OR connected_apps->'gmail'->>'accessToken' <> $3)`,
          [`"${tokenToUpdate}"`, userId, tokenToUpdate]
        );
        console.log(`[GmailSync] User ${userId}: Updated new access token "${tokenToUpdate.substring(0,10)}..." in DB.`);
        gmailCreds.accessToken = tokenToUpdate; // Update in-memory creds for current run
      } catch (dbError) {
        console.error(`[GmailSync] User ${userId}: Failed to update new access token in DB:`, dbError);
      }
    }
  };

  if (!listRes.data.messages || listRes.data.messages.length === 0) {
    console.log(`[GmailSync] User ${userId}: No messages found matching query.`);
    if (newAccessToken) { // Token might have been refreshed even if no messages
      await updateTokenInDb(newAccessToken);
    }
    return [];
  }

  const messages = listRes.data.messages; // Array of { id, threadId }

  const messageDetailsPromises = messages.map(async (msg) => {
    try {
      const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full", // MODIFIED: Fetch full message payload
      });
      return msgRes.data; // MODIFIED: Return the entire message object
    } catch (err) {
      console.warn(`[GmailSync] Failed to fetch message details for ${msg.id}, user ${userId}: ${err.message}`);
      if (err.code === 401 && newAccessToken) { // Check if auth error and token was refreshed
          console.warn(`[GmailSync] User ${userId}: Encountered 401, new token was available. Will be updated if not already.`);
      }
      return null;
    }
  });

  const resolvedMessageDetails = (await Promise.all(messageDetailsPromises)).filter(m => m !== null);

  // After all API calls, if a new token was received, update it.
  if (newAccessToken) {
    await updateTokenInDb(newAccessToken);
  }

  return resolvedMessageDetails;
}

// ---------- NEW: Store Email in S3 ----------
async function storeEmailInS3(userId, emailData) {
  if (!process.env.S3_RAW_BUCKET) {
    console.error("[GmailSync] S3_RAW_BUCKET environment variable is not set. Cannot store email.");
    return; // Skip storing this email
  }
  const s3Key = `raw_data/gmail/${userId}/${emailData.id}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_RAW_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(emailData, null, 2), // Store the full email object, pretty-printed
      ContentType: "application/json",
    }));
    console.log(`[GmailSync] Stored email ${emailData.id} for user ${userId} at S3 key: ${s3Key}`);
  } catch (error) {
    console.error(`[GmailSync] Error storing email ${emailData.id} for user ${userId} in S3:`, error);
    throw error; // Re-throw to allow processUserGmailData to catch and decide to continue or not
  }
}

// ---------- REWRITTEN: Process One User's Gmail Data ----------
async function processUserGmailData(user, dbClient) { // ADDED: dbClient
  const { id: userId, gmail: gmailCreds } = user;

  if (!gmailCreds || !gmailCreds.accessToken) {
    console.warn(`[GmailSync] User ${userId} is missing Gmail accessToken or gmailCreds. Skipping.`);
    return;
  }

  let rawEmails;
  try {
    // Pass dbClient for potential token updates within fetchGmailData
    rawEmails = await fetchGmailData(userId, gmailCreds, dbClient);
  } catch (error) {
    console.error(`[GmailSync] Failed to fetch Gmail data for user ${userId}:`, error.message);
    return; // Skip this user on critical fetch error
  }

  if (!rawEmails || rawEmails.length === 0) {
    console.log(`[GmailSync] User ${userId}: No emails fetched or returned to process.`);
    return;
  }

  console.log(`[GmailSync] User ${userId}: Fetched ${rawEmails.length} email(s).`);

  for (const email of rawEmails) {
    if (!email || !email.id) { // Basic validation of the email object
        console.warn(`[GmailSync] User ${userId}: Encountered an invalid email object structure, skipping. Email data:`, JSON.stringify(email).substring(0,100));
        continue;
    }
    try {
      await storeEmailInS3(userId, email);
    } catch (error) {
      console.error(`[GmailSync] Failed to process and store email ${email.id} for user ${userId}. Continuing with next email...`);
    }
  }
  console.log(`[GmailSync] Finished S3 storage processing for user ${userId}.`);
}

// ---------- Main Handler (Modified for new flow and DB client passing) ----------
exports.handler = async (event, context) => {
  console.log(`[GmailSync] Starting sync at ${new Date().toISOString()}`);
  let client; // PostgreSQL client

  try {
    client = await pool.connect();

    const userQueryRes = await client.query(`
      SELECT id, connected_apps->'gmail' AS gmail
      FROM users
      WHERE connected_apps->'gmail' IS NOT NULL
        AND connected_apps->'gmail'->>'accessToken' IS NOT NULL
        AND is_disabled = false
    `);
    const users = userQueryRes.rows.map(row => ({
      id: row.id,
      gmail: typeof row.gmail === "string" ? JSON.parse(row.gmail) : row.gmail,
    }));

    if (users.length === 0) {
      console.log("[GmailSync] No users found with active Gmail connection and access token.");
      return { statusCode: 200, body: "No Gmail users to sync." };
    }

    console.log(`[GmailSync] Found ${users.length} user(s) to process.`);

    for (const user of users) {
      if (!user.gmail || typeof user.gmail !== 'object') {
          console.warn(`[GmailSync] User ${user.id} has invalid or missing gmail credentials structure. Skipping.`);
          continue;
      }
      try {
        await processUserGmailData(user, client);
        console.log(`[GmailSync] User ${user.id} processed successfully.`);
      } catch (err) {
        console.error(`[GmailSync] Error processing user ${user.id}: ${err.message}`, err.stack);
      }
    }

    return { statusCode: 200, body: "Gmail sync completed for all applicable users." };

  } catch (err) {
    console.error("[GmailSync] Global error in handler:", err.message, err.stack);
    return { statusCode: 500, body: "Error in Gmail sync." };
  } finally {
    if (client) {
      client.release();
    }
  }
};
