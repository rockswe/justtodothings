"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const { WebClient, LogLevel } = require("@slack/web-api");
const zlib = require('zlib');

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
const LOOKBACK_SECONDS = parseInt(process.env.SLACK_LOOKBACK_SECONDS || `${72 * 3600}`, 10);
const DAILY_SWEEP_SECONDS = parseInt(process.env.SLACK_DAILY_SWEEP_SECONDS || `${24 * 3600}`, 10);

// --- Caching ---
// Simple in-memory caches for the duration of a single Lambda execution
let userInfoCache;
let channelInfoCache;

// --- Slack API Helper ---
function getSlackClient(token) {
  return new WebClient(token, {
    logLevel: process.env.SLACK_LOG_LEVEL ? LogLevel[process.env.SLACK_LOG_LEVEL.toLowerCase()] : LogLevel.INFO,
    retryConfig: { retries: 3 },
  });
}

async function with429Retry(fn, args) {
  try { return await fn(args); }
  catch (e) {
    const retry = e?.data?.retry_after || e?.retryAfter;
    if (retry) {
      await new Promise(r => setTimeout(r, Number(retry) * 1000));
      return fn(args);
    }
    throw e;
  }
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
      Body: Buffer.from(zlib.gzipSync(JSON.stringify(message))),
      ContentType: "application/json",
      ContentEncoding: "gzip",
    }));
  } catch (error) {
    console.error(`[SlackSync] Error storing message ${message.ts} for team ${teamId}, channel ${channelId} in S3:`, error);
  }
}

// Optionally store small index docs for quick scans (kept lightweight)
async function storeIndexDocInS3(teamId, channelId, docType, docId, docObject) {
  if (!S3_RAW_BUCKET_NAME) return;
  const safeDocId = String(docId).replace(/[^a-zA-Z0-9-_.]/g, '_');
  const s3Key = `raw_data/slack_index/${teamId}/${channelId}/${docType}/${safeDocId}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: Buffer.from(zlib.gzipSync(JSON.stringify(docObject))),
      ContentType: "application/json",
      ContentEncoding: "gzip",
    }));
  } catch (error) {
    console.error(`[SlackSync:index] Error storing index doc ${docType}:${safeDocId} for team ${teamId}, channel ${channelId}:`, error);
  }
}

// --- Mention Parsing Helpers ---
function extractMentionsFromText(text) {
  const userIds = new Set();
  const usergroupIds = new Set();
  if (!text) return { userIds, usergroupIds };
  try {
    for (const m of text.matchAll(/<@([A-Z0-9]+)>/g)) {
      if (m[1]) userIds.add(m[1]);
    }
    for (const m of text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
      if (m[1]) usergroupIds.add(m[1]);
    }
  } catch (_) {}
  return { userIds, usergroupIds };
}

function traverseRichTextElements(elements, out) {
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    if (!el) continue;
    if (el.type === 'user' && el.user_id) {
      out.userIds.add(el.user_id);
    } else if (el.type === 'usergroup' && el.usergroup_id) {
      out.usergroupIds.add(el.usergroup_id);
    } else if (el.type === 'rich_text_section' || el.type === 'rich_text_preformatted' || el.type === 'rich_text_list') {
      if (Array.isArray(el.elements)) traverseRichTextElements(el.elements, out);
    } else if (el.type === 'text' && el.text) {
      const { userIds, usergroupIds } = extractMentionsFromText(el.text);
      for (const u of userIds) out.userIds.add(u);
      for (const g of usergroupIds) out.usergroupIds.add(g);
    } else if (Array.isArray(el.elements)) {
      traverseRichTextElements(el.elements, out);
    }
  }
}

function extractMentionsFromBlocks(blocks) {
  const out = { userIds: new Set(), usergroupIds: new Set() };
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'rich_text' && Array.isArray(block.elements)) {
      traverseRichTextElements(block.elements, out);
    } else if (block.type === 'section') {
      if (block.text?.type === 'mrkdwn' && block.text.text) {
        const { userIds, usergroupIds } = extractMentionsFromText(block.text.text);
        for (const u of userIds) out.userIds.add(u);
        for (const g of usergroupIds) out.usergroupIds.add(g);
      }
      if (Array.isArray(block.fields)) {
        for (const f of block.fields) {
          if (f?.type === 'mrkdwn' && f.text) {
            const { userIds, usergroupIds } = extractMentionsFromText(f.text);
            for (const u of userIds) out.userIds.add(u);
            for (const g of usergroupIds) out.usergroupIds.add(g);
          }
        }
      }
    }
  }
  return out;
}

function isAskLike(text) {
  if (!text) return false;
  const re = /(review|approve|fix|update|send|ptal|due|by\s*(eod|tomorrow|\d{1,2}\/\d{1,2}))|\?/i;
  return re.test(text);
}

function computeMentionFlags(message, currentUserId, usergroupIdsForUser) {
  const textMentions = extractMentionsFromText(message.text || '');
  const blockMentions = extractMentionsFromBlocks(message.blocks || []);
  const mentionedUsers = new Set([...textMentions.userIds, ...blockMentions.userIds]);
  const mentionedGroups = new Set([...textMentions.usergroupIds, ...blockMentions.usergroupIds]);
  const isMention = mentionedUsers.has(currentUserId);
  let isUsergroupMention = false;
  for (const g of mentionedGroups) {
    if (usergroupIdsForUser.has(g)) { isUsergroupMention = true; break; }
  }
  return { isMention, isUsergroupMention };
}

function shouldSkipMessage(message) {
  const skipSubtypes = new Set(['channel_join','channel_leave','channel_topic','channel_purpose']); // don't auto-skip bot_message
  if (message.subtype && skipSubtypes.has(message.subtype)) return true;
  const text = (message.text || '').trim();
  const hasBlocks = Array.isArray(message.blocks) && message.blocks.length > 0;
  const hasFiles  = Array.isArray(message.files)  && message.files.length  > 0;
  if (!text && !hasBlocks && !hasFiles) return true;
  if (/^(?::[a-zA-Z0-9_+-]+:|\s)+$/.test(text)) return true;
  return false;
}

function computeOldestTs(lastProcessedTsSec, lookbackSeconds) {
  if (!lastProcessedTsSec) return undefined;
  const lookbackCutoff = (Date.now()/1000) - lookbackSeconds;
  const oldest = Math.min(Number(lastProcessedTsSec), lookbackCutoff);
  return oldest.toFixed(6);
}

// --- Context Fetching Helpers ---

async function fetchAndStoreTeamInfo(slackClient, teamId) {
    // Fetches team info once per run. Requires team:read scope.
    try {
        console.log(`[SlackSync] Fetching team info for Team ID: ${teamId}`);
        const teamInfoRes = await with429Retry(slackClient.team.info.bind(slackClient), {});
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
        const userInfoRes = await with429Retry(slackClient.users.info.bind(slackClient), { user: slackUserId });
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
        const channelInfoRes = await with429Retry(slackClient.conversations.info.bind(slackClient), { channel: channelId });
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

async function updateThreadWatchlistInDB(dbClient, userId, newWatchlist, currentSlackDataFromDB) {
  try {
    const newSlackDataForDB = {
      ...currentSlackDataFromDB,
      thread_watchlist: newWatchlist,
    };
    await dbClient.query(
      `UPDATE users SET connected_apps = jsonb_set(connected_apps, '{slack}', $1::jsonb, true) WHERE id = $2`,
      [JSON.stringify(newSlackDataForDB), userId]
    );
  } catch (error) {
    console.error(`[SlackSync] User ${userId}: Failed to update thread watchlist in DB:`, error);
  }
}

async function updateSlackSweepTimestampsInDB(dbClient, userId, propsToMerge, currentSlackDataFromDB) {
  try {
    const newSlackDataForDB = {
      ...currentSlackDataFromDB,
      ...propsToMerge,
    };
    await dbClient.query(
      `UPDATE users SET connected_apps = jsonb_set(connected_apps, '{slack}', $1::jsonb, true) WHERE id = $2`,
      [JSON.stringify(newSlackDataForDB), userId]
    );
  } catch (error) {
    console.error(`[SlackSync] User ${userId}: Failed to update sweep timestamps in DB:`, error);
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

async function fetchAndStoreThreadRepliesSince(slackClient, teamId, channelId, threadTs, oldestTs) {
  let newestTs = null;
  try {
    const base = { channel: channelId, ts: threadTs, limit: 200 };
    const nowTs = (Date.now() / 1000).toFixed(6);
    const params = oldestTs ? { ...base, oldest: oldestTs, latest: nowTs, inclusive: false } : { ...base, latest: nowTs, inclusive: false };
    for await (const page of slackClient.paginate("conversations.replies", params)) {
      if (page.messages && page.messages.length > 0) {
        for (const reply of page.messages) {
          if (reply.ts === threadTs) continue; // skip parent
          if (!newestTs || Number(reply.ts) > Number(newestTs)) newestTs = reply.ts;
          await storeMessageInS3(teamId, channelId, reply, threadTs);
        }
      }
      if (!page.response_metadata?.next_cursor) break;
    }
  } catch (error) {
    console.error(`[SlackSync] Error fetching replies since ${oldestTs} for thread ${threadTs} in channel ${channelId}, team ${teamId}:`, error.message);
  }
  return newestTs;
}

async function fetchAndStoreMessagesInConversation(slackClient, dbClient, userId, teamId, conversation, slackDataFromDB, isImOrMpim, currentUserId, usergroupIdsForUser, threadWatchlistState) {
  const channelId = conversation.id;
  const lastProcessedTs = slackDataFromDB.last_processed_ts_per_channel?.[channelId];
  let newestTsInThisRun = null;
  let messagesProcessedCount = 0;
  let watchlistChanged = false;

  console.log(`[SlackSync] User ${userId}, Channel ${channelId} (${conversation.name || 'N/A'}): Starting sync. Last TS: ${lastProcessedTs || 'None'}.`);
  
  // Fetch/cache channel info at the start of processing this conversation
  await fetchAndCacheChannelInfo(slackClient, channelId, teamId, isImOrMpim);

  try {
    const oldestParam = computeOldestTs(lastProcessedTs, LOOKBACK_SECONDS);
    const nowTs = (Date.now() / 1000).toFixed(6);
    for await (const page of slackClient.paginate("conversations.history", {
        channel: channelId,
        oldest: oldestParam,
        latest: nowTs,
        inclusive: false,
        limit: 200, 
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

          // mention flags first
          const { isMention, isUsergroupMention } = computeMentionFlags(message, currentUserId, usergroupIdsForUser);

          // now skip noise unless it mentions the user or their user-group
          if (shouldSkipMessage(message) && !isMention && !isUsergroupMention) continue;

          await storeMessageInS3(teamId, channelId, message);
          messagesProcessedCount++;

          // Fetch/cache user info for the message author
          if (message.user && !message.bot_id) { // message.user might be missing for some message types (e.g., channel join)
              await fetchAndCacheUserInfo(slackClient, message.user, teamId);
          }

          // Mention detection (already computed above) and thread watchlist logic
          const isParent = Boolean(message.thread_ts && message.ts === message.thread_ts);
          const isReply = Boolean(message.thread_ts && message.ts !== message.thread_ts);

          if (isParent) {
            if ((message.user && message.user === currentUserId) || isMention || isUsergroupMention) {
              const tts = message.thread_ts;
              if (!threadWatchlistState[tts]) {
                threadWatchlistState[tts] = { channel_id: channelId, last_seen_ts: message.ts, added_by: (message.user === currentUserId ? 'authored' : (isMention ? 'mentioned' : 'usergroup')), added_at: new Date().toISOString() };
                watchlistChanged = true;
              } else if (Number(message.ts) > Number(threadWatchlistState[tts].last_seen_ts)) {
                threadWatchlistState[tts].last_seen_ts = message.ts;
                watchlistChanged = true;
              }
            }
          } else if (isReply) {
            if (message.user && message.user === currentUserId) {
              const parentTs = message.thread_ts;
              if (!threadWatchlistState[parentTs]) {
                threadWatchlistState[parentTs] = { channel_id: channelId, last_seen_ts: message.ts, added_by: 'replied', added_at: new Date().toISOString() };
                watchlistChanged = true;
              } else if (Number(message.ts) > Number(threadWatchlistState[parentTs].last_seen_ts)) {
                threadWatchlistState[parentTs].last_seen_ts = message.ts;
                watchlistChanged = true;
              }
            }
          }

          const isWatched = isParent && threadWatchlistState[message.thread_ts];
          const shouldFetchReplies = isParent && ((message.user && message.user === currentUserId) || isMention || isUsergroupMention || isWatched);
          if (shouldFetchReplies && message.reply_count > 0) {
            await fetchAndStoreThreadReplies(slackClient, teamId, channelId, message.thread_ts);
          }
        }
      } else {
        break; 
      }
      if (!page.response_metadata?.next_cursor) break;
    }

    if (newestTsInThisRun && (!lastProcessedTs || Number(newestTsInThisRun) > Number(lastProcessedTs))) {
      await updateLastProcessedTsInDB(dbClient, userId, channelId, newestTsInThisRun, slackDataFromDB);
    }
    console.log(`[SlackSync] User ${userId}, Channel ${channelId}: Sync finished. ${messagesProcessedCount} new messages. Newest TS: ${newestTsInThisRun || 'Unchanged'}.`);

    if (watchlistChanged) {
      await updateThreadWatchlistInDB(dbClient, userId, threadWatchlistState, slackDataFromDB);
    }

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
  let currentUserId = null;

  // --- DEBUG: Check token scopes ---
  try {
    const authTestRes = await slackClient.auth.test();
    currentUserId = authTestRes.user_id;
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

  // Preload usergroup memberships for user-group mentions (best-effort)
  const usergroupIdsForUser = new Set();
  try {
    const ugList = await slackClient.usergroups.list({ include_users: true });
    if (ugList.ok && Array.isArray(ugList.usergroups)) {
      for (const ug of ugList.usergroups) {
        if (Array.isArray(ug.users)) {
          if (currentUserId && ug.users.includes(currentUserId)) usergroupIdsForUser.add(ug.id);
        } else {
          try {
            const ugUsers = await slackClient.usergroups.users.list({ usergroup: ug.id });
            if (ugUsers.ok && Array.isArray(ugUsers.users) && currentUserId && ugUsers.users.includes(currentUserId)) {
              usergroupIdsForUser.add(ug.id);
            }
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.warn(`[SlackSync] User ${userId}, Team ${teamId}: usergroups fetch/list not permitted: ${e.message}`);
  }

  const dmOptIn = Boolean(slackDataFromDB?.dm_opt_in);
  const types = dmOptIn ? 'public_channel,private_channel,im,mpim' : 'public_channel,private_channel';
  const threadWatchlistState = slackDataFromDB.thread_watchlist || {};
  const nowSec = Math.floor(Date.now() / 1000);
  const pinsLastSweepIso = slackDataFromDB.pins_last_sweep_iso;
  const bookmarksLastSweepIso = slackDataFromDB.bookmarks_last_sweep_iso;
  const pinsSweepDue = !pinsLastSweepIso || ((nowSec - Math.floor(new Date(pinsLastSweepIso).getTime() / 1000)) >= DAILY_SWEEP_SECONDS);
  const bookmarksSweepDue = !bookmarksLastSweepIso || ((nowSec - Math.floor(new Date(bookmarksLastSweepIso).getTime() / 1000)) >= DAILY_SWEEP_SECONDS);

  try {
    const activeChannelIds = new Set();
    for await (const page of slackClient.paginate("users.conversations", {
        limit: 200, 
        exclude_archived: true,
        types,
    })) {
      if (page.channels && page.channels.length > 0) {
        for (const conversation of page.channels) {
           const isImOrMpim = conversation.is_im || conversation.is_mpim;
           activeChannelIds.add(conversation.id);
           await fetchAndStoreMessagesInConversation(
             slackClient,
             dbClient,
             userId,
             teamId,
             conversation,
             slackDataFromDB,
             isImOrMpim,
             currentUserId,
             usergroupIdsForUser,
             threadWatchlistState
           );
         }
       }
      if (!page.response_metadata?.next_cursor) break;
    }
    console.log(`[SlackSync] User ${userId}, Team ${teamId}: Finished processing all conversations.`);

    // Poll watched threads for new replies since last_seen
    for (const [threadTs, meta] of Object.entries(threadWatchlistState)) {
      const channelId = meta.channel_id;
      if (!channelId) continue;
      const newest = await fetchAndStoreThreadRepliesSince(slackClient, teamId, channelId, threadTs, meta.last_seen_ts);
      if (newest && Number(newest) > Number(meta.last_seen_ts)) {
        meta.last_seen_ts = newest;
      }
    }
    const THREAD_TTL_SECONDS = parseInt(process.env.SLACK_THREAD_TTL_SECONDS || `${30*24*3600}`, 10);
    const cutoff = Math.floor(Date.now() / 1000) - THREAD_TTL_SECONDS;
    for (const [tts, meta] of Object.entries(threadWatchlistState)) {
      if (!meta.last_seen_ts || Number(meta.last_seen_ts) < cutoff) {
        delete threadWatchlistState[tts];
      }
    }
    await updateThreadWatchlistInDB(dbClient, userId, threadWatchlistState, slackDataFromDB);


    // Daily sweep pins and bookmarks for active channels only
    if (pinsSweepDue || bookmarksSweepDue) {
      for (const channelId of activeChannelIds) {
        try {
          if (pinsSweepDue) {
            const pins = await with429Retry(slackClient.pins.list.bind(slackClient), { channel: channelId });
            if (pins.ok) {
              await storeIndexDocInS3(teamId, channelId, 'pins_list', 'latest', pins.items || []);
            }
          }
        } catch (e) {
          console.warn(`[SlackSync] Pins sweep failed for channel ${channelId}: ${e.message}`);
        }
        try {
          if (bookmarksSweepDue) {
            const bms = await with429Retry(slackClient.bookmarks.list.bind(slackClient), { channel_id: channelId });
            if (bms.ok) {
              await storeIndexDocInS3(teamId, channelId, 'bookmarks_list', 'latest', bms.bookmarks || []);
            }
          }
        } catch (e) {
          console.warn(`[SlackSync] Bookmarks sweep failed for channel ${channelId}: ${e.message}`);
        }
      }
      const mergeProps = {};
      if (pinsSweepDue) mergeProps.pins_last_sweep_iso = new Date().toISOString();
      if (bookmarksSweepDue) mergeProps.bookmarks_last_sweep_iso = new Date().toISOString();
      if (Object.keys(mergeProps).length > 0) {
        await updateSlackSweepTimestampsInDB(dbClient, userId, mergeProps, slackDataFromDB);
      }
    }
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