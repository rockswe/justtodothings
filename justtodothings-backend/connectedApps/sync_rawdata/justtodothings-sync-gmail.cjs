"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const { google } = require("googleapis");

const s3 = new S3Client({});
const pool = new Pool({
    host: process.env.DB_HOST,     
    port: process.env.DB_PORT || 5432,   
    user: process.env.DB_USER,           
    password: process.env.DB_PASS,     
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: true }      
  });

const S3_RAW_BUCKET_NAME = process.env.S3_RAW_BUCKET;

// ---------- Gmail Data Fetching and Token Handling (Refined) ----------
async function fetchGmailDataWithHistory(userId, gmailCreds, dbClient) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: gmailCreds.accessToken,
    refresh_token: gmailCreds.refreshToken,
  });

  let tokenRefreshed = false;
  let newCredsForDB = { ...gmailCreds }; // Start with current creds

  oauth2Client.on('tokens', (tokens) => {
    console.log(`[GmailSync] User ${userId}: Tokens event received.`);
    if (tokens.access_token && tokens.access_token !== newCredsForDB.accessToken) {
      console.log(`[GmailSync] User ${userId}: New access token received via event.`);
      newCredsForDB.accessToken = tokens.access_token;
      tokenRefreshed = true;
    }
    if (tokens.refresh_token && tokens.refresh_token !== newCredsForDB.refreshToken) {
      console.log(`[GmailSync] User ${userId}: New refresh token received via event.`);
      newCredsForDB.refreshToken = tokens.refresh_token;
      tokenRefreshed = true;
    }
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const fetchedMessageDetails = [];
  let newHistoryIdToStore = gmailCreds.lastHistoryId; // Default to current if no changes

  try {
    if (gmailCreds.lastHistoryId) {
      console.log(`[GmailSync] User ${userId}: Syncing using startHistoryId: ${gmailCreds.lastHistoryId}`);
      let pageToken;
      do {
        const historyRes = await gmail.users.history.list({
          userId: "me",
          startHistoryId: gmailCreds.lastHistoryId,
          historyTypes: ["messageAdded"], // Focus on new messages
          pageToken: pageToken,
        });

        if (historyRes.data.history) {
          for (const record of historyRes.data.history) {
            if (record.messagesAdded) {
              for (const addedMsg of record.messagesAdded) {
                if (addedMsg.message) {
                  try {
                    const msgRes = await gmail.users.messages.get({ userId: "me", id: addedMsg.message.id, format: "full" });
                    fetchedMessageDetails.push(msgRes.data);
                  } catch (err) {
                    console.warn(`[GmailSync] User ${userId}: Failed to fetch details for added message ${addedMsg.message.id}: ${err.message}`);
                  }
                }
              }
            }
          }
        }
        pageToken = historyRes.data.nextPageToken;
        if (historyRes.data.historyId) {
            newHistoryIdToStore = historyRes.data.historyId;
        }
      } while (pageToken);
      console.log(`[GmailSync] User ${userId}: Processed history. Fetched ${fetchedMessageDetails.length} new messages. New historyId: ${newHistoryIdToStore}`);

    } else {
      // First time sync or no historyId: Fetch last N messages and get current historyId
      console.log(`[GmailSync] User ${userId}: No lastHistoryId found. Performing initial fetch for recent messages.`);
      const listRes = await gmail.users.messages.list({
        userId: "me",
        maxResults: 20, // Configurable: number of messages for initial fetch
        q: "", // Potentially add date filters for a very first sync if needed
      });

      if (listRes.data.messages && listRes.data.messages.length > 0) {
        for (const msg of listRes.data.messages) {
          try {
            const msgRes = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
            fetchedMessageDetails.push(msgRes.data);
          } catch (err) {
            console.warn(`[GmailSync] User ${userId}: Failed to fetch message ${msg.id} during initial fetch: ${err.message}`);
          }
        }
      }
      // After fetching, get the current history ID. This might come from the last list/get response, or a separate call.
      // For simplicity, if listRes.data.messages.list itself returns a historyId, use it. Otherwise, a getProfile might provide it.
      // The most reliable way after any operation is often another call if the specific response doesn't have it.
      // Let's assume the historyId from listRes or the last message.get is not directly available/reliable for this specific purpose.
      // A fresh getProfile call will give the current historyId.
      const profileInfo = await gmail.users.getProfile({ userId: "me" });
      if (profileInfo.data.historyId) {
        newHistoryIdToStore = profileInfo.data.historyId;
        console.log(`[GmailSync] User ${userId}: Initial fetch complete. Fetched ${fetchedMessageDetails.length} messages. Current historyId: ${newHistoryIdToStore}`);
      } else {
        console.warn(`[GmailSync] User ${userId}: Could not retrieve initial historyId after fetching messages.`);
      }
    }
  } catch (error) {
    console.error(`[GmailSync] User ${userId}: Error during Gmail data fetch: ${error.message}`, error);
    // If auth error, token might have been an issue despite refresh attempt
    if (error.code === 401 || error.message.includes("Unauthorized")) {
        tokenRefreshed = true; // Force DB update attempt if auth error, as creds might be stale
    }
  }

  if (tokenRefreshed || (newHistoryIdToStore && newHistoryIdToStore !== gmailCreds.lastHistoryId)) {
    console.log(`[GmailSync] User ${userId}: Attempting to update Gmail credentials/historyId in DB.`);
    newCredsForDB.lastHistoryId = newHistoryIdToStore; // Ensure new historyId is part of what's saved
    try {
      await dbClient.query(
        `UPDATE users SET connected_apps = jsonb_set(connected_apps, '{gmail}', $1::jsonb, true) WHERE id = $2`,
        [JSON.stringify(newCredsForDB), userId]
      );
      console.log(`[GmailSync] User ${userId}: Successfully updated Gmail credentials/historyId in DB. New history ID: ${newCredsForDB.lastHistoryId}`);
    } catch (dbError) {
      console.error(`[GmailSync] User ${userId}: Failed to update Gmail credentials/historyId in DB:`, dbError);
    }
  }
  return fetchedMessageDetails;
}

// ---------- Store Email in S3 ----------
async function storeEmailInS3(userId, emailData) {
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[GmailSync] S3_RAW_BUCKET environment variable is not set. Cannot store email.");
    return;
  }
  const s3Key = `raw_data/gmail/${userId}/${emailData.id}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(emailData, null, 2),
      ContentType: "application/json",
    }));
    // console.log(`[GmailSync] Stored email ${emailData.id} for user ${userId} at S3 key: ${s3Key}`);
  } catch (error) {
    console.error(`[GmailSync] Error storing email ${emailData.id} for user ${userId} in S3:`, error);
    throw error;
  }
}

// ---------- Process One User's Gmail Data ----------
async function processUserGmailData(user, dbClient) {
  const { id: userId, gmail: gmailCredsFromDB } = user;

  if (!gmailCredsFromDB || !gmailCredsFromDB.accessToken) {
    console.warn(`[GmailSync] User ${userId} is missing Gmail accessToken or credentials. Skipping.`);
    return;
  }

  let rawEmails;
  try {
    rawEmails = await fetchGmailDataWithHistory(userId, { ...gmailCredsFromDB }, dbClient);
  } catch (error) {
    console.error(`[GmailSync] User ${userId}: Critical error during fetchGmailDataWithHistory: ${error.message}`);
    return;
  }

  if (!rawEmails || rawEmails.length === 0) {
    console.log(`[GmailSync] User ${userId}: No new emails fetched to process.`);
    return;
  }

  console.log(`[GmailSync] User ${userId}: Fetched ${rawEmails.length} new email(s) via history.`);

  for (const email of rawEmails) {
    if (!email || !email.id) {
        console.warn(`[GmailSync] User ${userId}: Encountered an invalid email object structure from fetch, skipping. Email data:`, JSON.stringify(email).substring(0,100));
        continue;
    }
    try {
      await storeEmailInS3(userId, email);
    } catch (error) {
      console.error(`[GmailSync] User ${userId}: Failed to store email ${email.id}. Continuing with next email...`);
    }
  }
  console.log(`[GmailSync] User ${userId}: Finished S3 storage for new Gmail emails.`);
}

// ---------- Main Handler ----------
exports.handler = async (event, context) => {
  console.log(`[GmailSync] Starting Gmail sync (with history tracking) at ${new Date().toISOString()}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[GmailSync] Critical: S3_RAW_BUCKET environment variable is not set. Aborting.");
    return { statusCode: 500, body: "S3_RAW_BUCKET not configured." };
  }
  let client;
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
      if (!user.gmail || typeof user.gmail !== 'object' || !user.gmail.accessToken) {
          console.warn(`[GmailSync] User ${user.id} has invalid or missing Gmail credentials structure in DB. Skipping.`);
          continue;
      }
      await processUserGmailData(user, client);
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