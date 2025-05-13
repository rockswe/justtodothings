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
  console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Starting fetch. Initial Creds:`, { hasAccessToken: !!gmailCreds.accessToken, hasRefreshToken: !!gmailCreds.refreshToken, lastHistoryId: gmailCreds.lastHistoryId });
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: gmailCreds.accessToken,
    refresh_token: gmailCreds.refreshToken,
  });
  console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: OAuth2 client configured.`);

  let tokenRefreshed = false;
  let newCredsForDB = { ...gmailCreds }; // Start with current creds

  oauth2Client.on('tokens', (tokens) => {
    console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Tokens event received.`);
    if (tokens.access_token && tokens.access_token !== newCredsForDB.accessToken) {
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: New access token received via event.`);
      newCredsForDB.accessToken = tokens.access_token;
      tokenRefreshed = true;
    }
    if (tokens.refresh_token && tokens.refresh_token !== newCredsForDB.refreshToken) {
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: New refresh token received via event.`);
      newCredsForDB.refreshToken = tokens.refresh_token;
      tokenRefreshed = true;
    }
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const fetchedMessageDetails = [];
  let newHistoryIdToStore = gmailCreds.lastHistoryId; // Default to current if no changes
  console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Initial historyId to check/use: ${newHistoryIdToStore}`);

  try {
    if (gmailCreds.lastHistoryId) {
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Syncing using startHistoryId: ${gmailCreds.lastHistoryId}`);
      let pageToken;
      let pageCount = 0;
      do {
        pageCount++;
        console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Fetching history page ${pageCount} with pageToken: ${pageToken}`);
        const historyRes = await gmail.users.history.list({
          userId: "me",
          startHistoryId: gmailCreds.lastHistoryId,
          historyTypes: ["messageAdded"], // Focus on new messages
          pageToken: pageToken,
        });

        console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: History page ${pageCount} response received. History entries: ${historyRes.data.history?.length || 0}`);

        if (historyRes.data.history) {
          for (const record of historyRes.data.history) {
            if (record.messagesAdded) {
              for (const addedMsg of record.messagesAdded) {
                if (addedMsg.message) {
                  try {
                    console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Fetching details for added message ID: ${addedMsg.message.id}`);
                    const msgRes = await gmail.users.messages.get({ userId: "me", id: addedMsg.message.id, format: "full" });
                    fetchedMessageDetails.push(msgRes.data);
                    console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Successfully fetched details for message ID: ${addedMsg.message.id}`);
                  } catch (err) {
                    console.warn(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Failed to fetch details for added message ${addedMsg.message.id}: ${err.message}`);
                  }
                }
              }
            }
          }
        }
        pageToken = historyRes.data.nextPageToken;
        console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Next page token for history: ${pageToken}`);
        if (historyRes.data.historyId) {
            console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: History response contains historyId: ${historyRes.data.historyId}. Updating potential newHistoryIdToStore.`);
            newHistoryIdToStore = historyRes.data.historyId;
        }
      } while (pageToken);
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Processed history. Fetched ${fetchedMessageDetails.length} new messages. New historyId to store: ${newHistoryIdToStore}`);

    } else {
      // First time sync or no historyId: Fetch last N messages and get current historyId
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: No lastHistoryId found. Performing initial fetch for recent messages.`);
      const listRes = await gmail.users.messages.list({
        userId: "me",
        maxResults: 50, // Configurable: Increased number of messages for initial fetch
        q: "", // Potentially add date filters for a very first sync if needed
      });

      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Initial message list response received. Messages found: ${listRes.data.messages?.length || 0}`);

      if (listRes.data.messages && listRes.data.messages.length > 0) {
        for (const msg of listRes.data.messages) {
          try {
            console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Fetching details for initial message ID: ${msg.id}`);
            const msgRes = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
            fetchedMessageDetails.push(msgRes.data);
            console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Successfully fetched initial message ID: ${msg.id}`);
          } catch (err) {
            console.warn(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Failed to fetch message ${msg.id} during initial fetch: ${err.message}`);
          }
        }
      }
      // For simplicity, if listRes.data.messages.list itself returns a historyId, use it. Otherwise, a getProfile might provide it.
      // The most reliable way after any operation is often another call if the specific response doesn't have it.
      // Let's assume the historyId from listRes or the last message.get is not directly available/reliable for this specific purpose.
      // A fresh getProfile call will give the current historyId.
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Fetching profile info to get current historyId.`);
      const profileInfo = await gmail.users.getProfile({ userId: "me" });
      if (profileInfo.data.historyId) {
        newHistoryIdToStore = profileInfo.data.historyId;
        console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Initial fetch complete. Fetched ${fetchedMessageDetails.length} messages. Current historyId from profile: ${newHistoryIdToStore}`);
      } else {
        console.warn(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Could not retrieve initial historyId after fetching messages.`);
      }
    }
  } catch (error) {
    console.error(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Error during Gmail data fetch: ${error.message}`, error);
    // If auth error, token might have been an issue despite refresh attempt
    if (error.code === 401 || error.message.includes("Unauthorized")) {
        console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Encountered 401/Unauthorized error. Marking token as potentially refreshed.`);
        tokenRefreshed = true; // Force DB update attempt if auth error, as creds might be stale
    }
  }

  if (tokenRefreshed || (newHistoryIdToStore && newHistoryIdToStore !== gmailCreds.lastHistoryId)) {
    console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Conditions met for updating DB. Token Refreshed: ${tokenRefreshed}, History ID changed: ${newHistoryIdToStore !== gmailCreds.lastHistoryId} (New: ${newHistoryIdToStore}, Old: ${gmailCreds.lastHistoryId})`);
    newCredsForDB.lastHistoryId = newHistoryIdToStore; // Ensure new historyId is part of what's saved
    try {
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Attempting DB update with new creds/historyId:`, { email: newCredsForDB.email, hasAccessToken: !!newCredsForDB.accessToken, hasRefreshToken: !!newCredsForDB.refreshToken, lastHistoryId: newCredsForDB.lastHistoryId });
      await dbClient.query(
        `UPDATE users SET connected_apps = jsonb_set(connected_apps, '{gmail}', $1::jsonb, true) WHERE id = $2`,
        [JSON.stringify(newCredsForDB), userId]
      );
      console.log(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Successfully updated Gmail credentials/historyId in DB. New history ID: ${newCredsForDB.lastHistoryId}`);
    } catch (dbError) {
      console.error(`[GmailSync:fetchGmailDataWithHistory] User ${userId}: Failed to update Gmail credentials/historyId in DB:`, dbError);
    }
  }
  return fetchedMessageDetails;
}

// ---------- Transform Raw Email Data ----------
/**
 * Transforms the raw email data from Gmail API (format: "full") 
 * into a more concise structure for storage and processing.
 * @param {string} userId - The ID of the user for logging purposes.
 * @param {object} rawEmailData - The raw email object from gmail.users.messages.get.
 * @returns {object} - The processed email object.
 */
function transformRawEmail(userId, rawEmailData) {
    const processed = {
        // Core Identifiers
        id: rawEmailData.id,
        threadId: rawEmailData.threadId,
        historyId: rawEmailData.historyId, // History ID when this message state was fetched

        // Labels & Status
        labelIds: rawEmailData.labelIds || [],
        isUnread: (rawEmailData.labelIds || []).includes('UNREAD'),

        // Basic Metadata
        // Convert Unix ms timestamp to ISO 8601 string
        internalDate: rawEmailData.internalDate ? new Date(parseInt(rawEmailData.internalDate, 10)).toISOString() : null,
        snippet: rawEmailData.snippet || '',

        // Routing & Threading Headers
        messageIdHeader: null,
        from: null,
        to: [],
        cc: [],
        bcc: [],
        subject: null,
        inReplyTo: null,
        references: [], // Changed default to empty array

        // Content
        bodyText: null,
        bodyHtml: null,

        // Attachments (Metadata only)
        attachments: [],

        // Size
        sizeEstimate: rawEmailData.sizeEstimate || 0,
    };

    // 1. Parse Headers
    const headers = rawEmailData.payload?.headers || [];
    // Helper to find header value, case-insensitive
    const findHeader = (name) => {
      const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
      return header?.value || null;
    }
    // Helper to parse potentially comma-separated email address headers
    const parseAddressList = (headerName) => {
        const value = findHeader(headerName);
        return value ? value.split(',').map(s => s.trim()).filter(Boolean) : []; // Filter out empty strings if trailing comma exists
    }
    // Helper to parse space-separated references header
    const parseReferences = (headerName) => {
        const value = findHeader(headerName);
        // Split by one or more whitespace characters
        return value ? value.split(/\s+/).map(s => s.trim()).filter(Boolean) : []; 
    }


    processed.messageIdHeader = findHeader('Message-ID');
    processed.from = findHeader('From');
    processed.to = parseAddressList('To');
    processed.cc = parseAddressList('Cc');
    processed.bcc = parseAddressList('Bcc'); // Often not present on received emails
    processed.subject = findHeader('Subject');
    processed.inReplyTo = findHeader('In-Reply-To');
    processed.references = parseReferences('References');

    // 2. Extract Body and Attachments (Recursive Function)
    function findBodyParts(part) {
        if (!part) return;

        const mimeType = part.mimeType?.toLowerCase();
        const attachmentId = part.body?.attachmentId;
        const data = part.body?.data;
        const size = part.body?.size || 0;
        let filename = part.filename || null;

        // Prioritize plain text
        if (mimeType === 'text/plain' && data && !processed.bodyText) {
           try { 
               // Decode Base64URL
               processed.bodyText = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); 
            } catch (e) { 
                console.warn(`[GmailSync:transformRawEmail] User ${userId} Email ${processed.id}: Error decoding text/plain body: ${e.message}`);
            }
        } 
        // Fallback to HTML
        else if (mimeType === 'text/html' && data && !processed.bodyHtml) {
             try { 
                 // Decode Base64URL
                 processed.bodyHtml = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); 
             } catch (e) { 
                 console.warn(`[GmailSync:transformRawEmail] User ${userId} Email ${processed.id}: Error decoding text/html body: ${e.message}`);
             }
        } 
        // Recurse for multipart messages
        else if (mimeType?.startsWith('multipart/') && part.parts) {
            part.parts.forEach(findBodyParts); 
        } 
        
        // Handle Attachments (including inline images treated as attachments)
        // Attachment ID is the key identifier
        if (attachmentId) {
            // Ensure filename exists, generate one if necessary (e.g., for inline images without filename)
            if (!filename) {
                const extension = mimeType ? mimeType.split('/')[1] : 'bin'; // Basic extension from MIME type
                filename = `attachment_${attachmentId}.${extension}`;
            }
            // Avoid duplicate entries if parts structure is complex
             if (!processed.attachments.find(a => a.attachmentId === attachmentId)) {
                 processed.attachments.push({
                    attachmentId: attachmentId,
                    filename: filename,
                    mimeType: part.mimeType || 'application/octet-stream', // Default MIME if missing
                    size: size,
                 });
             }
        }
    }

    if (rawEmailData.payload) {
        findBodyParts(rawEmailData.payload);
    }

    // Fallback for simple (non-multipart) emails where body is directly in payload
    const topLevelMimeType = rawEmailData.payload?.mimeType?.toLowerCase();
    const topLevelBodyData = rawEmailData.payload?.body?.data;

    if (topLevelBodyData && !processed.bodyText && !processed.bodyHtml) { // Only if not already found in parts
        if (topLevelMimeType === 'text/plain') {
            try { 
                processed.bodyText = Buffer.from(topLevelBodyData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); 
            } catch (e) { console.warn(`[GmailSync:transformRawEmail] User ${userId} Email ${processed.id}: Error decoding simple text body: ${e.message}`);}
        } else if (topLevelMimeType === 'text/html') {
             try { 
                 processed.bodyHtml = Buffer.from(topLevelBodyData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); 
            } catch (e) { console.warn(`[GmailSync:transformRawEmail] User ${userId} Email ${processed.id}: Error decoding simple html body: ${e.message}`);}
        }
    }

    return processed;
}

// ---------- Store Email in S3 ----------
// Modified to accept processed email data
async function storeEmailInS3(userId, processedEmailData) { // <-- Changed parameter name
  if (!S3_RAW_BUCKET_NAME) {
    console.error(`[GmailSync:storeEmailInS3] User ${userId}: S3_RAW_BUCKET environment variable is not set. Cannot store email ID: ${processedEmailData?.id}`);
    return; // Keep return here
  }
  // Use the ID from the processed data
  const s3Key = `raw_data/gmail/${userId}/${processedEmailData.id}.json`; 
  try {
    // Commenting out per-email log for reduced verbosity
    // console.log(`[GmailSync:storeEmailInS3] User ${userId}: Attempting to store processed email ID ${processedEmailData.id} to S3 key: ${s3Key}`);
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(processedEmailData, null, 2), // Store the processed object
      ContentType: "application/json",
    }));
    // console.log(`[GmailSync:storeEmailInS3] Stored processed email ${processedEmailData.id} for user ${userId} at S3 key: ${s3Key}`); // Keep commented for less noise
  } catch (error) {
    console.error(`[GmailSync:storeEmailInS3] User ${userId}: Error storing processed email ${processedEmailData.id} in S3:`, error);
    throw error; // Re-throw the error
  }
}

// ---------- Process One User's Gmail Data ----------
// Modified to use the transformer
async function processUserGmailData(user, dbClient) {
  const { id: userId, gmail: gmailCredsFromDB } = user;
  // Keep initial log, but maybe shorten it if too verbose
  // console.log(`[GmailSync:processUserGmailData] Processing user ${userId}. Raw DB data:`, JSON.stringify(gmailCredsFromDB)); 

  if (!gmailCredsFromDB || !gmailCredsFromDB.accessToken) {
    console.warn(`[GmailSync:processUserGmailData] User ${userId} is missing Gmail accessToken or credentials structure. Skipping. Credentials received:`, gmailCredsFromDB);
    return;
  }

  let rawEmails;
  try {
    console.log(`[GmailSync:processUserGmailData] User ${userId}: Calling fetchGmailDataWithHistory.`);
    // Pass userId to the transform function context if needed inside (e.g., for logging)
    // Note: transformRawEmail needs access to userId for its logs, so we either pass it 
    // or make userId accessible in its scope. Passing might be cleaner if it remains a pure function.
    // Let's adjust transformRawEmail signature slightly for this.
    rawEmails = await fetchGmailDataWithHistory(userId, { ...gmailCredsFromDB }, dbClient); 
  } catch (error) {
    console.error(`[GmailSync:processUserGmailData] User ${userId}: Critical error during fetchGmailDataWithHistory: ${error.message}`, error);
    return; // Exit if fetch fails critically
  }

   if (!rawEmails || rawEmails.length === 0) {
     console.log(`[GmailSync:processUserGmailData] User ${userId}: No new emails fetched to process.`);
     return;
  }

  // Log changed to reflect transformation step
  console.log(`[GmailSync:processUserGmailData] User ${userId}: Fetched ${rawEmails.length} raw email(s). Transforming and storing...`);

  let processedCount = 0;
  let failedCount = 0;

  for (const rawEmail of rawEmails) {
    // Basic validation of the raw object structure before attempting transformation
    if (!rawEmail || !rawEmail.id || !rawEmail.threadId) { 
        console.warn(`[GmailSync:processUserGmailData] User ${userId}: Encountered an invalid raw email object structure from fetch, skipping. ID: ${rawEmail?.id}`);
        failedCount++;
        continue; 
    }
    try {
      // Commenting out per-email log for reduced verbosity
      // console.log(`[GmailSync:processUserGmailData] User ${userId}: Transforming email ID ${rawEmail.id}.`); // Potentially verbose
      
      // Pass userId to transformRawEmail for logging context
      const processedEmail = transformRawEmail(userId, rawEmail); // <-- TRANSFORM HERE, pass userId
      
      // Commenting out per-email log for reduced verbosity
      // console.log(`[GmailSync:processUserGmailData] User ${userId}: Storing processed email ID ${processedEmail.id}.`); // Potentially verbose
      await storeEmailInS3(userId, processedEmail); // <-- Store processed data
      processedCount++;
      // console.log(`[GmailSync:processUserGmailData] User ${userId}: Successfully processed and stored email ID ${processedEmail.id}.`); // Verbose
    } catch (error) {
      // Log error from transform/store step, but continue with others
      console.error(`[GmailSync:processUserGmailData] User ${userId}: Failed to transform or store raw email ${rawEmail.id}. Error: ${error.message}`);
      failedCount++;
    }
  }
  // Summarize outcome for the user
  console.log(`[GmailSync:processUserGmailData] User ${userId}: Finished processing. Stored: ${processedCount}, Failed: ${failedCount}.`);
}

// ---------- Main Handler ----------
exports.handler = async (event, context) => {
  console.log(`[GmailSync:Handler] Starting Gmail sync (with history tracking) at ${new Date().toISOString()}. Request ID: ${context?.awsRequestId}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[GmailSync:Handler] Critical: S3_RAW_BUCKET environment variable is not set. Aborting.");
    return { statusCode: 500, body: "S3_RAW_BUCKET not configured." };
  }
  let client;
  try {
    console.log("[GmailSync:Handler] Attempting to connect to database...");
    client = await pool.connect();
    console.log("[GmailSync:Handler] Database connection successful.");
    const userQuery = `
      SELECT id, connected_apps->'gmail' AS gmail
      FROM users
      WHERE connected_apps->'gmail' IS NOT NULL
        AND connected_apps->'gmail'->>'accessToken' IS NOT NULL
        AND is_disabled = false
    `;
    console.log("[GmailSync:Handler] Executing user query:", userQuery);
    const userQueryRes = await client.query(userQuery);
    console.log(`[GmailSync:Handler] User query executed. Number of rows returned: ${userQueryRes.rows.length}`);
    const users = userQueryRes.rows.map(row => ({
      id: row.id,
      gmail: typeof row.gmail === "string" ? JSON.parse(row.gmail) : row.gmail,
    }));

    if (users.length === 0) {
      console.log("[GmailSync:Handler] No users found with active Gmail connection and access token based on query results.");
      return { statusCode: 200, body: "No Gmail users to sync." };
    }

    console.log(`[GmailSync:Handler] Found ${users.length} user(s) to process.`);

    for (const user of users) {
      console.log(`[GmailSync:Handler] Processing user ID: ${user.id}. Checking credentials structure...`);
      if (!user.gmail || typeof user.gmail !== 'object' || !user.gmail.accessToken) {
          console.warn(`[GmailSync:Handler] User ${user.id} has invalid or missing Gmail credentials structure in DB after map. Skipping. Data:`, user.gmail);
          continue;
      }
      console.log(`[GmailSync:Handler] User ${user.id} credentials look valid. Calling processUserGmailData.`);
      await processUserGmailData(user, client);
      console.log(`[GmailSync:Handler] Finished processing user ID: ${user.id}.`);
    }
    console.log("[GmailSync:Handler] Finished processing all users.");
    return { statusCode: 200, body: "Gmail sync completed for all applicable users." };

  } catch (err) {
    console.error("[GmailSync:Handler] Global error in handler:", err.message, err.stack);
    return { statusCode: 500, body: "Error in Gmail sync." };
  } finally {
    if (client) {
      console.log("[GmailSync:Handler] Releasing database client.");
      client.release();
      console.log("[GmailSync:Handler] Database client released.");
    } else {
        console.log("[GmailSync:Handler] No database client to release (likely connection error).");
    }
    console.log("[GmailSync:Handler] Handler execution finished.");
  }
};