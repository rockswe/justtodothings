"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const { WebClient, LogLevel } = require("@slack/web-api");

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

// --- Slack API Helper ---
function getSlackClient(token) {
  return new WebClient(token, {
    logLevel: process.env.SLACK_LOG_LEVEL ? LogLevel[process.env.SLACK_LOG_LEVEL.toLowerCase()] : LogLevel.INFO,
  });
}

// --- S3 Storage Helper ---
async function storeMessageInS3(teamId, channelId, message, parentMessageTs = null) {
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[SlackSync] S3_RAW_BUCKET environment variable is not set. Cannot store message.");
    return;
  }
  if (!message || !message.ts) {
    console.warn("[SlackSync] Attempted to store message without a timestamp (ts). Skipping.", { channelId, teamId });
    return;
  }
  let s3Key;
  if (parentMessageTs) {
    s3Key = `raw_data/slack/${teamId}/${channelId}/thread_replies/${parentMessageTs}/${message.ts}.json`;
  } else {
    s3Key = `raw_data/slack/${teamId}/${channelId}/${message.ts}.json`;
  }
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(message, null, 2),
      ContentType: "application/json",
    }));
  } catch (error) {
    console.error(`[SlackSync] Error storing message ${message.ts} for team ${teamId}, channel ${channelId} in S3:`, error);
  }
}

// --- Database Helper for Timestamps ---
async function updateLastProcessedTsInDB(dbClient, userId, channelId, newTs, currentSlackDataFromDB) {
  if (!newTs) return;

  const updatedTsPerChannel = {
    ...(currentSlackDataFromDB.last_processed_ts_per_channel || {}),
    [channelId]: newTs,
  };
  // Construct the new slack object carefully to ensure other slack-related creds are preserved
  const newSlackDataForDB = {
    ...currentSlackDataFromDB, // Preserve existing fields like accessToken, team_id, etc.
    last_processed_ts_per_channel: updatedTsPerChannel,
  };

  try {
    await dbClient.query(
      `UPDATE users SET connected_apps = jsonb_set(connected_apps, '{slack}', $1::jsonb, true) WHERE id = $2`,
      [JSON.stringify(newSlackDataForDB), userId]
    );
  } catch (error) {
    console.error(`[SlackSync] User ${userId}: Failed to update last processed ts for channel ${channelId} in DB:`, error);
  }
}

// --- Message Fetching Logic ---
async function fetchAndStoreThreadReplies(slackClient, teamId, channelId, threadTs) {
  try {
    for await (const page of slackClient.paginate("conversations.replies", { channel: channelId, ts: threadTs, limit: 200 })) {
      if (page.messages && page.messages.length > 0) {
        for (const reply of page.messages) {
          // replies are chronological (oldest first). Parent message (threadTs) is typically the first message in the array.
          if (reply.ts !== threadTs) { // Only store actual replies, not the parent message itself again.
             await storeMessageInS3(teamId, channelId, reply, threadTs);
          }
        }
      }
      if (!page.response_metadata?.next_cursor) break;
    }
  } catch (error) {
    console.error(`[SlackSync] Error fetching replies for thread ${threadTs} in channel ${channelId}, team ${teamId}:`, error.message);
  }
}

async function fetchAndStoreMessagesInConversation(slackClient, dbClient, userId, teamId, conversation, slackDataFromDB) {
  const channelId = conversation.id;
  const lastProcessedTs = slackDataFromDB.last_processed_ts_per_channel?.[channelId];
  let newestTsInThisRun = null; // Will hold the TS of the newest message processed in this specific run
  let messagesProcessedCount = 0;

  console.log(`[SlackSync] User ${userId}, Channel ${channelId} (${conversation.name || 'N/A'}): Starting sync. Last TS: ${lastProcessedTs || 'None'}.`);

  try {
    for await (const page of slackClient.paginate("conversations.history", {
        channel: channelId,
        oldest: lastProcessedTs, // Slack's 'oldest' is exclusive. Fetches messages *after* this TS.
        limit: 100, 
    })) {
      if (page.messages && page.messages.length > 0) {
        // Messages are generally newest first. The first message.ts in the first page is the overall newest for this fetch.
        if (!newestTsInThisRun) {
          newestTsInThisRun = page.messages[0].ts;
        }

        for (const message of page.messages) {
          // Defensive check: ensure not re-processing the message at lastProcessedTs.
          // Should not be necessary if 'oldest' is strictly exclusive, but safe.
          if (message.ts === lastProcessedTs) continue;

          await storeMessageInS3(teamId, channelId, message);
          messagesProcessedCount++;

          if (message.thread_ts && message.reply_count && message.ts === message.thread_ts) {
            await fetchAndStoreThreadReplies(slackClient, teamId, channelId, message.thread_ts);
          }
        }
      } else {
        break; 
      }
      if (!page.response_metadata?.next_cursor) break;
    }

    if (newestTsInThisRun && newestTsInThisRun !== lastProcessedTs) {
      await updateLastProcessedTsInDB(dbClient, userId, channelId, newestTsInThisRun, slackDataFromDB);
    }
    console.log(`[SlackSync] User ${userId}, Channel ${channelId}: Sync finished. ${messagesProcessedCount} new messages. Newest TS: ${newestTsInThisRun || 'Unchanged'}.`);

  } catch (error) {
    console.error(`[SlackSync] User ${userId}, Channel ${channelId}: Error fetching messages: ${error.message}`, error.response?.data);
    if (error.data?.error === 'not_in_channel') {
        console.warn(`[SlackSync] User ${userId}: Bot/user not in channel ${channelId}. Skipping further processing for this channel.`);
    }
  }
}

// --- Per-User Slack Data Processing ---
async function processUserSlackData(user, dbClient) {
  const { id: userId, slack: slackDataFromDB } = user;

  if (!slackDataFromDB || !slackDataFromDB.accessToken) {
    console.warn(`[SlackSync] User ${userId} is missing Slack accessToken. Skipping.`);
    return;
  }
  // CRITICAL: team_id is essential for S3 path uniqueness if the bot/app is in multiple workspaces.
  // It should be fetched during OAuth and stored alongside the accessToken.
  const teamId = slackDataFromDB.team_id;
  if (!teamId) {
      console.error(`[SlackSync] User ${userId}: team_id is MISSING from Slack credentials. S3 paths will be incorrect. Skipping user.`);
      // TODO: Consider marking this user's Slack connection as needing re-authentication to fetch team_id.
      return;
  }
  const token = slackDataFromDB.accessToken;
  const slackClient = getSlackClient(token);

  console.log(`[SlackSync] User ${userId}, Team ${teamId}: Starting Slack sync.`);

  try {
    for await (const page of slackClient.paginate("conversations.list", {
        types: "public_channel,private_channel,mpim,im",
        limit: 200, 
        exclude_archived: true,
    })) {
      if (page.channels && page.channels.length > 0) {
        for (const conversation of page.channels) {
           // For bot tokens, is_member is usually true for channels it's in. IMs don't have is_member.
           // For user tokens, is_member=true means user is part of the channel.
           // This simple check is generally okay; if a channel is listed, the token should have some access.
           // If specific logic for user tokens vs bot tokens is needed for channel access, refine here.
           // Example: if (slackDataFromDB.token_type === 'user' && conversation.is_member === false && !conversation.is_im) continue;
          await fetchAndStoreMessagesInConversation(slackClient, dbClient, userId, teamId, conversation, slackDataFromDB);
        }
      }
      if (!page.response_metadata?.next_cursor) break;
    }
    console.log(`[SlackSync] User ${userId}, Team ${teamId}: Finished processing all conversations.`);
  } catch (error) {
    console.error(`[SlackSync] User ${userId}, Team ${teamId}: Error during Slack processing: ${error.message}`, error.response?.data);
    if (error.data?.error === 'token_revoked' || error.data?.error === 'invalid_auth') {
        console.error(`[SlackSync] User ${userId}: Slack token invalid/revoked. Consider DB flag for re-auth.`);
    }
  }
}

// --- Main Handler ---
exports.handler = async (event, context) => {
  console.log(`[SlackSync] Starting Slack sync at ${new Date().toISOString()}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[SlackSync] Critical: S3_RAW_BUCKET environment variable not set. Aborting.");
    return { statusCode: 500, body: "S3_RAW_BUCKET not configured." };
  }
  let dbClient;
  try {
    dbClient = await pool.connect();
    const userQueryRes = await dbClient.query(`
      SELECT id, connected_apps->'slack' AS slack
      FROM users
      WHERE connected_apps->'slack' IS NOT NULL
        AND connected_apps->'slack'->>'accessToken' IS NOT NULL
        AND connected_apps->'slack'->>'team_id' IS NOT NULL -- Ensure team_id is present
        AND is_disabled = false
    `);
    const users = userQueryRes.rows.map(row => ({
      id: row.id,
      slack: typeof row.slack === "string" ? JSON.parse(row.slack) : row.slack,
    }));

    if (users.length === 0) {
      console.log("[SlackSync] No users found with active Slack connection (including accessToken and team_id).");
      return { statusCode: 200, body: "No Slack users to sync." };
    }
    console.log(`[SlackSync] Found ${users.length} user(s) to process for Slack.`);

    for (const user of users) {
      // Basic checks already handled by SQL, but an extra check for user.slack object integrity is fine.
      if (!user.slack || !user.slack.accessToken || !user.slack.team_id) {
          console.warn(`[SlackSync] User ${user.id} data from DB is missing critical Slack fields (accessToken or team_id). Skipping.`);
          continue;
      }
      await processUserSlackData(user, dbClient);
    }
    return { statusCode: 200, body: "Slack sync completed for all applicable users." };
  } catch (err) {
    console.error("[SlackSync] Global error in handler:", err.message, err.stack);
    return { statusCode: 500, body: "Error in Slack sync." };
  } finally {
    if (dbClient) dbClient.release();
  }
};
