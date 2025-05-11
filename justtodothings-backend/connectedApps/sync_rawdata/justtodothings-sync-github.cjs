"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const axios = require("axios");

const s3 = new S3Client({});
const pool = new Pool({
    host: process.env.DB_HOST,     
    port: process.env.DB_PORT || 5432,   
    user: process.env.DB_USER,           
    password: process.env.DB_PASS,     
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: true }      
  });
const GITHUB_API_BASE_URL = process.env.GITHUB_API_BASE_URL || "https://api.github.com";
const S3_RAW_BUCKET_NAME = process.env.S3_RAW_BUCKET;

// --- GitHub API Helper ---
async function callGitHubApi(token, endpoint, params = {}, etag = null) {
  const url = `${GITHUB_API_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  if (etag) {
    headers["If-None-Match"] = etag;
  }

  try {
    const response = await axios.get(url, { headers, params });
    return { data: response.data, etag: response.headers.etag, status: response.status };
  } catch (error) {
    if (error.response) {
        if (error.response.status === 304) { // Not Modified
            return { data: null, etag: error.response.headers.etag, status: 304 };
        }
        console.error(`[GitHubSync] Error calling GitHub API ${url} (Status: ${error.response.status}): ${error.message}`, error.response.data);
        if (error.response.status === 401) {
            throw new Error(`GitHub API Unauthorized (401) for endpoint ${endpoint}. Token might be invalid.`);
        }
        if (error.response.status === 403) {
            console.warn(`[GitHubSync] GitHub API Forbidden (403) for endpoint ${endpoint}. Rate limits or permissions. Headers:`, error.response.headers);
            throw new Error(`GitHub API Forbidden (403) for endpoint ${endpoint}.`);
        }
    } else {
        console.error(`[GitHubSync] Error calling GitHub API ${url} (No response): ${error.message}`);
    }
    throw error;
  }
}

// --- S3 Storage ---
async function storeGitHubDataItemInS3(userId, owner, repoName, itemType, itemId, itemData) {
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[GitHubSync] S3_RAW_BUCKET environment variable is not set. Cannot store item.");
    return;
  }
  const safeItemId = String(itemId).replace(/[^a-zA-Z0-9-_.]/g, '_'); // Allow dots for SHAs
  const s3Key = `raw_data/github/${userId}/${owner}/${repoName}/${itemType}/${safeItemId}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(itemData, null, 2),
      ContentType: "application/json",
    }));
    // console.log(`[GitHubSync] Stored ${itemType} ${safeItemId} for user ${userId}, repo ${owner}/${repoName}`);
  } catch (error) {
    console.error(`[GitHubSync] Error storing ${itemType} ${safeItemId} for user ${userId} in S3:`, error);
  }
}

// --- DB Helpers for ETag/LastEventID (Conceptual) ---
// These would interact with connected_apps.github in the users table
async function getRepoMetadata(dbClient, userId, repoFullName) {
  // In a real scenario, fetch from DB: connected_apps.github.repo_metadata[repoFullName]
  // For this demo, we assume it might be passed in or we always fetch if not found.
  // This function is more a placeholder for where you'd get stored ETag / last event ID.
  const res = await dbClient.query(
    "SELECT connected_apps->'github'->'repo_metadata'->>$1 AS metadata FROM users WHERE id = $2",
    [repoFullName, userId]
  );
  if (res.rows.length > 0 && res.rows[0].metadata) {
    return typeof res.rows[0].metadata === 'string' ? JSON.parse(res.rows[0].metadata) : res.rows[0].metadata;
  }
  return { etag: null, lastEventId: null }; 
}

async function updateRepoMetadata(dbClient, userId, repoFullName, etag, lastEventId) {
    // Update connected_apps.github.repo_metadata[repoFullName] = { etag, lastEventId }
    // Ensure existing repo_metadata or github object is not overwritten entirely.
    // This requires careful JSONB updates.
    const path = `'{github,repo_metadata,${repoFullName}}'`; // Construct JSONB path
    const value = JSON.stringify({ etag, lastEventId });

    // Ensure github and repo_metadata objects exist before setting the specific repo's metadata
    await dbClient.query(
      `UPDATE users SET connected_apps = jsonb_set(
        jsonb_set(connected_apps, '{github}', connected_apps->'github' || '{}'::jsonb, true),
        '{github,repo_metadata}', (connected_apps->'github'->'repo_metadata') || '{}'::jsonb, true
      ) WHERE id = $1 AND connected_apps->'github' IS NOT NULL;`, 
      [userId]
    );
    
    await dbClient.query(
        `UPDATE users SET connected_apps = jsonb_set(connected_apps, ${path}, $1::jsonb, true) WHERE id = $2`,
        [value, userId]
    );
    // console.log(`[GitHubSync] User ${userId}, Repo ${repoFullName}: Updated ETag/LastEventID.`);
}

// --- Per-User GitHub Data Processing ---
async function processUserGitHubData(user, dbClient) {
  const { id: userId, github: githubCreds } = user;

  if (!githubCreds || !githubCreds.accessToken) {
    console.warn(`[GitHubSync] User ${userId} is missing GitHub accessToken. Skipping.`);
    return;
  }
  const token = githubCreds.accessToken;
  // TODO: Store and use lastRepoCheckTimestamp for /user/repos if API doesn't fully support efficient delta for this.
  let repositories;
  try {
    // Fetch a limited number of recently updated repos. For more robust repo delta, track last checked time.
    const repoResponse = await callGitHubApi(token, "/user/repos", { type: "owner", sort: "updated", per_page: 50 });
    repositories = repoResponse.data;
  } catch (error) {
    console.error(`[GitHubSync] User ${userId}: Failed to fetch repositories: ${error.message}`);
    return;
  }

  if (!repositories || repositories.length === 0) {
    console.log(`[GitHubSync] User ${userId}: No repositories found.`);
    return;
  }
  console.log(`[GitHubSync] User ${userId}: Found ${repositories.length} repositories. Processing events...`);

  for (const repo of repositories) {
    const owner = repo.owner.login;
    const repoName = repo.name;
    const repoFullName = repo.full_name; // Used as key for etag/lastEventId storage

    const storedMeta = await getRepoMetadata(dbClient, userId, repoFullName);
    let currentEtag = storedMeta.etag;
    let lastProcessedEventId = storedMeta.lastEventId;
    let newLastEventIdInPage = null;

    try {
      console.log(`[GitHubSync] User ${userId}, Repo ${repoFullName}: Fetching events. ETag: ${currentEtag}, LastEventID: ${lastProcessedEventId}`);
      const eventResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/events`, { per_page: 30 }, currentEtag);

      if (eventResponse.status === 304) {
        console.log(`[GitHubSync] User ${userId}, Repo ${repoFullName}: Events not modified (304).`);
        continue; // No new events, ETag is still valid for next time.
      }
      currentEtag = eventResponse.etag; // Update ETag from the successful response
      const events = eventResponse.data;

      if (events && events.length > 0) {
        console.log(`[GitHubSync] User ${userId}, Repo ${repoFullName}: Fetched ${events.length} events.`);
        newLastEventIdInPage = events[0].id; // Events are newest first

        for (const event of events) {
          if (event.id === lastProcessedEventId) {
            console.log(`[GitHubSync] User ${userId}, Repo ${repoFullName}: Reached last processed event ID (${event.id}). Stopping for this repo.`);
            break; // Stop if we've seen this event before
          }
          await storeGitHubDataItemInS3(userId, owner, repoName, "events", event.id, event);

          // TODO: Enhance - Based on event.type, fetch full details of related items (commits, issues, PRs)
          // Example for PushEvent:
          // if (event.type === 'PushEvent' && event.payload.commits) {
          //   for (const commitStub of event.payload.commits) {
          //     try {
          //       const commitDetails = await callGitHubApi(token, `/repos/${owner}/${repoName}/commits/${commitStub.sha}`);
          //       await storeGitHubDataItemInS3(userId, owner, repoName, "commits", commitStub.sha, commitDetails.data);
          //     } catch (commitErr) { console.error(`Error fetching commit ${commitStub.sha}: ${commitErr.message}`); }
          //   }
          // }
          // Example for IssuesEvent or PullRequestEvent:
          // if ((event.type === 'IssuesEvent' || event.type === 'PullRequestEvent') && event.payload.action && event.payload.issue) { // or event.payload.pull_request
          //   const itemUrl = event.payload.issue?.url || event.payload.pull_request?.url;
          //   if(itemUrl){ // itemUrl is like https://api.github.com/repos/owner/repo/issues/1
          //      const itemDetails = await callGitHubApi(token, new URL(itemUrl).pathname); // extracts /repos/owner/repo/issues/1
          //      const itemType = event.type === 'IssuesEvent' ? 'issues' : 'pull_requests';
          //      await storeGitHubDataItemInS3(userId, owner, repoName, itemType, itemDetails.data.number || itemDetails.data.id, itemDetails.data);
          //   }
          // }
        }
      } else {
        console.log(`[GitHubSync] User ${userId}, Repo ${repoFullName}: No new events fetched despite 200 OK (possibly empty).`);
      }
      // Update metadata for the repo (new ETag, new lastEventId from this page)
      if (newLastEventIdInPage) {
        await updateRepoMetadata(dbClient, userId, repoFullName, currentEtag, newLastEventIdInPage);
      }
    } catch (error) {
      console.error(`[GitHubSync] User ${userId}, Repo ${repoFullName}: Failed to process events: ${error.message}`);
    }
  }
  console.log(`[GitHubSync] User ${userId}: Finished GitHub data processing.`);
}


// --- Main Handler ---
exports.handler = async (event, context) => {
  console.log(`[GitHubSync] Starting GitHub sync at ${new Date().toISOString()}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[GitHubSync] Critical: S3_RAW_BUCKET environment variable is not set. Aborting.");
    return { statusCode: 500, body: "S3_RAW_BUCKET not configured." };
  }
  let client;
  try {
    client = await pool.connect();
    const sqlQuery = `
      SELECT id, connected_apps->'github' AS github
      FROM users
      WHERE connected_apps->'github' IS NOT NULL
        AND connected_apps->'github'->>'accessToken' IS NOT NULL
        AND is_disabled = false
    `;
    const userQueryRes = await client.query(sqlQuery);
    const users = userQueryRes.rows.map(row => ({
      id: row.id,
      github: typeof row.github === "string" ? JSON.parse(row.github) : row.github,
    }));

    if (users.length === 0) {
      console.log("[GitHubSync] No users found with active GitHub connection and access token.");
      return { statusCode: 200, body: "No GitHub users to sync." };
    }
    console.log(`[GitHubSync] Found ${users.length} user(s) to process.`);

    for (const user of users) {
      if (!user.github || typeof user.github !== 'object' || !user.github.accessToken) {
          console.warn(`[GitHubSync] User ${user.id} has invalid or missing GitHub credentials. Skipping.`);
          continue;
      }
      await processUserGitHubData(user, client);
    }
    return { statusCode: 200, body: "GitHub sync completed for all applicable users." };
  } catch (err) {
    console.error("[GitHubSync] Global error in handler:", err.message, err.stack);
    return { statusCode: 500, body: "Error in GitHub sync." };
  } finally {
    if (client) client.release();
  }
};
