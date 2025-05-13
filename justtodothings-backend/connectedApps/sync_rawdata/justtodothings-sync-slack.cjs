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

// --- Caching ---
// Simple in-memory caches for the duration of a single Lambda execution
let userInfoCache;
let channelInfoCache;

// --- Slack API Helper ---
function getSlackClient(token) {
  return new WebClient(token, {
    logLevel: process.env.SLACK_LOG_LEVEL ? LogLevel[process.env.SLACK_LOG_LEVEL.toLowerCase()] : LogLevel.INFO,
  });
}

// --- S3 Storage Helpers ---

// Generalized S3 storage function
async function storeGenericSlackDataInS3(teamId, dataType, dataId, dataObject) {
  if (!S3_RAW_BUCKET_NAME) {
    console.error(`[SlackSync:storeGenericSlackDataInS3] S3_RAW_BUCKET not set. Cannot store ${dataType} ${dataId}.`);
    return;
  }
  // Construct a path based on data type. Ensure dataId is filesystem-safe.
  const safeDataId = String(dataId).replace(/[^a-zA-Z0-9-_.]/g, '_');
  let s3Key;
  if (dataType === 'team_info') {
    s3Key = `raw_data/slack/${teamId}/team_info/${safeDataId}.json`; // e.g., info.json
  } else if (dataType === 'user') {
     s3Key = `raw_data/slack/${teamId}/users/${safeDataId}.json`; // e.g., U012345.json
  } else if (dataType === 'channel_info') {
     s3Key = `raw_data/slack/${teamId}/channels/${safeDataId}_info.json`; // e.g., C0ABCDEFG_info.json
  } else {
     console.warn(`[SlackSync:storeGenericSlackDataInS3] Unknown dataType: ${dataType}. Cannot determine S3 path.`);
     return; // Or define a default path / error handling
  }

  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(dataObject, null, 2),
      ContentType: "application/json",
    }));
    console.log(`[SlackSync:storeGenericSlackDataInS3] SUCCESS storing ${dataType} ${safeDataId} for team ${teamId} to S3 key: ${s3Key}`);
  } catch (error) {
    console.error(`[SlackSync:storeGenericSlackDataInS3] S3 PUT FAILED for ${dataType} ${safeDataId}, team ${teamId}, key ${s3Key}:`, error);
  }
}

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

// --- Context Fetching Helpers ---

async function fetchAndStoreTeamInfo(slackClient, teamId) {
    // Fetches team info once per run. Requires team:read scope.
    try {
        console.log(`[SlackSync] Fetching team info for Team ID: ${teamId}`);
        const teamInfoRes = await slackClient.team.info();
        if (teamInfoRes.ok && teamInfoRes.team) {
            await storeGenericSlackDataInS3(teamId, 'team_info', 'info', teamInfoRes.team);
        } else {
            console.warn(`[SlackSync] Failed to fetch team info for Team ID: ${teamId}`, teamInfoRes.error);
        }
    } catch (error) {
        console.error(`[SlackSync] Error calling team.info for Team ID ${teamId}: ${error.message}`);
    }
}


async function fetchAndCacheUserInfo(slackClient, slackUserId, teamId) {
    // Fetches user info if not in cache, stores in S3. Requires users:read scope.
    if (!slackUserId) {
        // console.warn('[SlackSync:fetchAndCacheUserInfo] No Slack User ID provided.'); // May be noisy for bot messages etc.
        return null; 
    }
    if (userInfoCache.has(slackUserId)) {
        // console.log(`[SlackSync:fetchAndCacheUserInfo] Cache HIT for user ${slackUserId}`);
        return userInfoCache.get(slackUserId);
    }
    console.log(`[SlackSync:fetchAndCacheUserInfo] Cache MISS for user ${slackUserId}. Fetching...`);
    try {
        const userInfoRes = await slackClient.users.info({ user: slackUserId });
        if (userInfoRes.ok && userInfoRes.user) {
            const userData = userInfoRes.user;
            userInfoCache.set(slackUserId, userData); // Add to cache
            await storeGenericSlackDataInS3(teamId, 'user', slackUserId, userData);
            return userData;
        } else {
            console.warn(`[SlackSync:fetchAndCacheUserInfo] Failed to fetch info for user ${slackUserId}:`, userInfoRes.error);
            userInfoCache.set(slackUserId, null); // Cache null to prevent retries for this user in this run
            return null;
        }
    } catch (error) {
        console.error(`[SlackSync:fetchAndCacheUserInfo] Error calling users.info for ${slackUserId}: ${error.message}`);
        userInfoCache.set(slackUserId, null); // Cache null on error
        return null;
    }
}

async function fetchAndCacheChannelInfo(slackClient, channelId, teamId, isImOrMpim) {
    // Fetches channel info if not in cache, stores in S3. Requires appropriate read scopes (channels:read etc.).
    // Skip for IMs/MPIMs as conversations.info doesn't apply well or might lack useful metadata like topic/purpose.
    if (isImOrMpim) {
        // console.log(`[SlackSync:fetchAndCacheChannelInfo] Skipping info fetch for IM/MPIM channel ${channelId}`);
        return null;
    }
     if (channelInfoCache.has(channelId)) {
        // console.log(`[SlackSync:fetchAndCacheChannelInfo] Cache HIT for channel ${channelId}`);
        return channelInfoCache.get(channelId);
    }
    console.log(`[SlackSync:fetchAndCacheChannelInfo] Cache MISS for channel ${channelId}. Fetching...`);
    try {
        const channelInfoRes = await slackClient.conversations.info({ channel: channelId });
        if (channelInfoRes.ok && channelInfoRes.channel) {
            const channelData = channelInfoRes.channel;
            // Store relevant subset or full data? Let's store a useful subset for now.
            const infoToStore = {
                id: channelData.id,
                name: channelData.name,
                created: channelData.created,
                creator: channelData.creator,
                is_archived: channelData.is_archived,
                is_general: channelData.is_general,
                is_private: channelData.is_private,
                is_im: channelData.is_im,
                is_mpim: channelData.is_mpim,
                topic: channelData.topic?.value,
                purpose: channelData.purpose?.value,
                num_members: channelData.num_members, // Note: May not be present on all channel types or for user tokens without certain permissions.
                // last_read: channelData.last_read, // Could be useful for user tokens
            };
            channelInfoCache.set(channelId, infoToStore); // Add to cache
            await storeGenericSlackDataInS3(teamId, 'channel_info', channelId, infoToStore);
            return infoToStore;
        } else {
            console.warn(`[SlackSync:fetchAndCacheChannelInfo] Failed to fetch info for channel ${channelId}:`, channelInfoRes.error);
            channelInfoCache.set(channelId, null); // Cache null to prevent retries
            return null;
        }
    } catch (error) {
        console.error(`[SlackSync:fetchAndCacheChannelInfo] Error calling conversations.info for ${channelId}: ${error.message}`);
        channelInfoCache.set(channelId, null); // Cache null on error
        return null;
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
             // Fetch/cache user info for the reply author
             if (reply.user) { // reply.user might be missing for some message types
                await fetchAndCacheUserInfo(slackClient, reply.user, teamId);
             }
          }
        }
      }
      if (!page.response_metadata?.next_cursor) break;
    }
  } catch (error) {
    console.error(`[SlackSync] Error fetching replies for thread ${threadTs} in channel ${channelId}, team ${teamId}:`, error.message);
  }
}

async function fetchAndStoreMessagesInConversation(slackClient, dbClient, userId, teamId, conversation, slackDataFromDB, isImOrMpim) {
  const channelId = conversation.id;
  const lastProcessedTs = slackDataFromDB.last_processed_ts_per_channel?.[channelId];
  let newestTsInThisRun = null;
  let messagesProcessedCount = 0;

  console.log(`[SlackSync] User ${userId}, Channel ${channelId} (${conversation.name || 'N/A'}): Starting sync. Last TS: ${lastProcessedTs || 'None'}.`);
  
  // Fetch/cache channel info at the start of processing this conversation
  await fetchAndCacheChannelInfo(slackClient, channelId, teamId, isImOrMpim);

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

          // Fetch/cache user info for the message author
          if (message.user) { // message.user might be missing for some message types (e.g., channel join)
              await fetchAndCacheUserInfo(slackClient, message.user, teamId);
          }

          if (message.thread_ts && message.reply_count && message.ts === message.thread_ts) {
            // Pass caches down to thread fetching
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
  const teamId = slackDataFromDB.team_id;
  if (!teamId) {
      console.error(`[SlackSync] User ${userId}: team_id is MISSING from Slack credentials. S3 paths will be incorrect. Skipping user.`);
      return;
  }
  const token = slackDataFromDB.accessToken;
  const slackClient = getSlackClient(token);

  // --- DEBUG: Check token scopes ---
  try {
    const authTestRes = await slackClient.auth.test();
    console.log(`[SlackSync] DEBUG User ${userId}, Team ${teamId}: auth.test successful. User: ${authTestRes.user_id}, Team: ${authTestRes.team_id}. Scopes from header: ${authTestRes.response_metadata?.scopes?.join(',')}`);
    // Note: The primary scope info is often in the response headers, accessed via response_metadata by the SDK
  } catch (authErr) {
    console.error(`[SlackSync] DEBUG User ${userId}, Team ${teamId}: auth.test FAILED: ${authErr.message}`);
  }
  // --- END DEBUG ---

  // Initialize caches for this user's run
  userInfoCache = new Map();
  channelInfoCache = new Map();

  console.log(`[SlackSync] User ${userId}, Team ${teamId}: Starting Slack sync.`);
  
  // Fetch and store team info once
  await fetchAndStoreTeamInfo(slackClient, teamId); // Requires team:read scope

  try {
    for await (const page of slackClient.paginate("conversations.list", {
        limit: 200, 
        exclude_archived: true,
    })) {
      if (page.channels && page.channels.length > 0) {
        for (const conversation of page.channels) {
           // Skip public/private channels the bot/user isn't a member of.
           // Also skip MPIMs if is_member is false (though usually not applicable for MPIMs listed for a user token)
           const isImOrMpim = conversation.is_im || conversation.is_mpim;
           if (conversation.is_member === false && !isImOrMpim) {
               console.log(`[SlackSync] User ${userId}, Team ${teamId}: Skipping channel ${conversation.id} (${conversation.name || 'N/A'}) because bot/user is not a member.`);
               continue;
           }
           // Pass caches down
           await fetchAndStoreMessagesInConversation(slackClient, dbClient, userId, teamId, conversation, slackDataFromDB, isImOrMpim);
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
    console.error("[SlackSync] Critical: S3_RAW_BUCKET environment variable is not set. Aborting.");
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