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

// --- HTTP client & headers ---
const http = axios.create({ timeout: 15000 });
const BASE_HEADERS = {
  Accept: 'application/vnd.github.v3+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'justtodothings-sync/1.0'
};

// Safe stringify for logs
function safeJson(obj, max = 4096) {
  try {
    const s = JSON.stringify(obj);
    return s && s.length > max ? s.slice(0, max) + '…' : s;
  } catch (_) {
    const s = String(obj || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
}

// Tiny retry for transient upstream errors
http.interceptors.response.use(undefined, async (err) => {
  const status = err.response?.status;
  if ([502, 503, 504].includes(status) && !err.config?.__retried) {
    err.config.__retried = true;
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
    return http.request(err.config);
  }
  throw err;
});

// --- GitHub API Helper ---
async function callGitHubApi(token, endpoint, params = {}, etag = null) {
  console.log(`[callGitHubApi] Calling Endpoint: ${endpoint}, ETag: ${etag}`);
  const url = `${GITHUB_API_BASE_URL}${endpoint}`;
  const headers = {
    ...BASE_HEADERS,
    Authorization: `token ${token}`
  };
  if (etag) {
    headers["If-None-Match"] = etag;
  }

  try {
    const response = await http.get(url, { headers, params });
    console.log(`[callGitHubApi] Success for ${endpoint}. Status: ${response.status}, ETag: ${response.headers.etag}, Data Length: ${response.data ? (Array.isArray(response.data) ? response.data.length : 'N/A') : 'N/A'}`);
    return { data: response.data, etag: response.headers.etag, status: response.status };
  } catch (error) {
    if (error.response) {
        const rlReset = error.response.headers?.['x-ratelimit-reset'];
        const ssoHeader = error.response.headers?.['x-github-sso'];
        const scopes = error.response.headers?.['x-oauth-scopes'];
        const acceptedScopes = error.response.headers?.['x-accepted-oauth-scopes'];
        console.error(`[callGitHubApi] Error for ${url}. Status: ${error.response.status}, Data: ${safeJson(error.response.data)}, Scopes: ${scopes} (accepted: ${acceptedScopes})`);
        if (error.response.status === 304) {
            console.log(`[callGitHubApi] Status 304 (Not Modified) for ${endpoint}. ETag: ${error.response.headers.etag}`);
            return { data: null, etag: error.response.headers.etag, status: 304 };
        }
        if (error.response.status === 401) {
            console.error(`[callGitHubApi] GitHub API Unauthorized (401) for endpoint ${endpoint}.`);
            throw new Error(`GitHub API Unauthorized (401) for endpoint ${endpoint}. Token might be invalid.`);
        }
        if (error.response.status === 403) {
            if (ssoHeader && ssoHeader.includes('required')) {
              console.warn(`[callGitHubApi] SSO required for ${endpoint}. Skipping this scope.`);
              return { data: null, etag: null, status: 403 };
            }
            if (rlReset) {
              console.warn(`[callGitHubApi] Rate limited. Resumes at ${new Date(Number(rlReset) * 1000).toISOString()}`);
              return { data: null, etag: null, status: 403 };
            }
            console.warn(`[callGitHubApi] GitHub API Forbidden (403) for endpoint ${endpoint}.`);
            return { data: null, etag: null, status: 403 };
        }
    } else {
        console.error(`[callGitHubApi] Network/Request Error for ${url}: ${error.message}`);
    }
    throw error;
  }
}

// --- GitHub GraphQL Helper ---
async function callGitHubGraphQL(token, query, variables = {}) {
  function graphqlUrlFromBase(base) {
    return base.endsWith('/api/v3') ? base.replace('/api/v3', '/api/graphql') : `${base}/graphql`;
  }
  const url = graphqlUrlFromBase(GITHUB_API_BASE_URL);
  try {
    const response = await http.post(
      url,
      { query, variables },
      { headers: { ...BASE_HEADERS, Authorization: `bearer ${token}` } }
    );
    const data = response.data;
    if (data?.errors) {
      const rateLimited = Array.isArray(data.errors) && data.errors.some(e => /rate limit/i.test(e?.message || '') || e?.type === 'RATE_LIMITED');
      if (rateLimited) {
        console.warn('[callGitHubGraphQL] Secondary rate limit hit; skipping this query batch.');
        return null;
      }
      throw new Error(`GraphQL errors: ${safeJson(data.errors)}`);
    }
    return data.data;
  } catch (error) {
    if (error.response) {
      const scopes = error.response.headers?.['x-oauth-scopes'];
      const acceptedScopes = error.response.headers?.['x-accepted-oauth-scopes'];
      console.error(`[callGitHubGraphQL] Error ${error.response.status}: ${safeJson(error.response.data)}, Scopes: ${scopes} (accepted: ${acceptedScopes})`);
    } else {
      console.error(`[callGitHubGraphQL] Network/Request Error: ${error.message}`);
    }
    throw error;
  }
}

// Helper to handle GitHub API pagination
async function fetchAllGitHubPages(token, endpoint, params = {}) {
  let items = [];
  let url = `${GITHUB_API_BASE_URL}${endpoint}`;
  const headers = { ...BASE_HEADERS, Authorization: `token ${token}` };
  let page = 1; // GitHub API pagination is 1-based

  console.log(`[fetchAllGitHubPages] Starting pagination for ${endpoint}`);

  while (url) {
    try {
      console.log(`[fetchAllGitHubPages] Fetching page ${page} for ${endpoint}`);
      // Only pass params on the first request; subsequent pages use absolute Link URLs
      const isFirstPage = page === 1;
      const response = await http.get(url, {
          headers,
          params: isFirstPage ? { ...params, page: page, per_page: 100 } : undefined
      });

      if (response.data && Array.isArray(response.data)) {
        items = items.concat(response.data);
        console.log(`[fetchAllGitHubPages] Fetched ${response.data.length} items from page ${page}. Total now: ${items.length}`);
      } else {
        console.warn(`[fetchAllGitHubPages] Received non-array data or empty data on page ${page} for ${endpoint}. Stopping pagination.`);
        url = null; // Stop pagination if data is not as expected
        break;
      }

      // Check for Link header for pagination
      const linkHeader = response.headers.link;
      if (linkHeader) {
        const links = linkHeader.split(',').reduce((acc, linkPart) => {
          const match = linkPart.match(/<([^>]+)>;\s*rel="([^"]+)"/);
          if (match) acc[match[2]] = match[1];
          return acc;
        }, {});

        if (links.next) {
          // The link header provides the full URL, no need to construct it
          url = links.next; 
          page++; // Increment page counter for logging
        } else {
          url = null; // No 'next' link, reached the last page
        }
      } else {
        url = null; // No Link header, assume single page
      }
    } catch (error) {
      const status = error.response?.status;
      const rlReset = error.response?.headers?.['x-ratelimit-reset'];
      const ssoHeader = error.response?.headers?.['x-github-sso'];
      console.error(`[fetchAllGitHubPages] Error fetching page ${page} for ${endpoint}: ${error.message}`);
      if (error.response) {
          console.error(`[fetchAllGitHubPages] Error details: Status ${status}, Data: ${safeJson(error.response.data)}`);
      }
      if (status === 403) {
        if (ssoHeader && ssoHeader.includes('required')) {
          console.warn(`[fetchAllGitHubPages] SSO required for ${endpoint}. Returning items fetched so far (${items.length}).`);
          return items;
        }
        if (rlReset) {
          console.warn(`[fetchAllGitHubPages] Rate limited for ${endpoint}. Resumes at ${new Date(Number(rlReset) * 1000).toISOString()}. Returning items fetched so far (${items.length}).`);
          return items;
        }
      }
      url = null; 
      throw error; // Re-throw the error to be handled by the caller
    }
  }

  console.log(`[fetchAllGitHubPages] Finished pagination for ${endpoint}. Total items fetched: ${items.length}`);
  return items;
}

// Function to fetch all user repositories
async function fetchUserRepositories(token) {
  console.log(`[fetchUserRepositories] Fetching repositories for user.`);
  const params = { 
    affiliation: "owner,collaborator,organization_member",
    sort: "updated", // Sort by updated to potentially process active repos first
    direction: "desc"
  };
  try {
    const repos = await fetchAllGitHubPages(token, '/user/repos', params);
    console.log(`[fetchUserRepositories] Fetched ${repos.length} total repositories.`);
    return repos;
  } catch (error) {
    console.error(`[fetchUserRepositories] Failed to fetch user repositories: ${error.message}`);
    return []; // Return empty array on failure
  }
}

// Function to fetch user organizations
async function fetchUserOrganizations(token) {
  console.log(`[fetchUserOrganizations] Fetching organizations for user.`);
  try {
    const orgs = await fetchAllGitHubPages(token, '/user/orgs');
    console.log(`[fetchUserOrganizations] Fetched ${orgs.length} organizations.`);
    return orgs;
  } catch (error) {
    console.error(`[fetchUserOrganizations] Failed to fetch user organizations: ${error.message}`);
    return []; // Return empty array on failure
  }
}

// --- S3 Storage ---
async function storeGitHubDataItemInS3(userId, owner, repoName, itemType, itemId, itemData) {
  console.log(`[storeGitHubDataItemInS3] Storing: UserID: ${userId}, Repo: ${owner}/${repoName}, ItemType: ${itemType}, ItemID: ${itemId}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[storeGitHubDataItemInS3] S3_RAW_BUCKET environment variable is not set.");
    return;
  }
  const safeItemId = String(itemId).replace(/[^a-zA-Z0-9-_.]/g, '_');
  const s3Key = `raw_data/github/${userId}/${owner}/${repoName}/${itemType}/${safeItemId}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(itemData, null, 2),
      ContentType: "application/json",
    }));
  } catch (error) {
    console.error(`[storeGitHubDataItemInS3] Error storing ${itemType} ${safeItemId} for user ${userId} to S3 Key ${s3Key}:`, error);
  }
}

// New function to store user-level summary data (like repo list, org list)
async function storeGitHubUserSummaryDataInS3(userId, dataType, data) {
  console.log(`[storeGitHubUserSummaryDataInS3] Storing ${dataType} for UserID: ${userId}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[storeGitHubUserSummaryDataInS3] S3_RAW_BUCKET environment variable is not set.");
    return;
  }
  // Example: raw_data/github/<userId>/_summary/repositories.json
  const s3Key = `raw_data/github/${userId}/_summary/${dataType}.json`; 
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    }));
    console.log(`[storeGitHubUserSummaryDataInS3] Successfully stored ${dataType} for user ${userId} to S3 Key ${s3Key}.`);
  } catch (error) {
    console.error(`[storeGitHubUserSummaryDataInS3] Error storing ${dataType} for user ${userId} to S3 Key ${s3Key}:`, error);
  }
}

// Store minimal index documents (PRs, Issues, Security) under a compact namespace
async function storeGitHubIndexDocInS3(userId, category, owner, repoName, itemId, doc) {
  console.log(`[storeGitHubIndexDocInS3] Storing index doc: ${category} ${owner}/${repoName}#${itemId} for user ${userId}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[storeGitHubIndexDocInS3] S3_RAW_BUCKET environment variable is not set.");
    return;
  }
  const safeId = String(itemId).replace(/[^a-zA-Z0-9-_.]/g, '_');
  const s3Key = `raw_data/github/${userId}/_index/${category}/${owner}/${repoName}/${safeId}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(doc, null, 2),
      ContentType: "application/json",
    }));
    console.log(`[storeGitHubIndexDocInS3] Stored ${s3Key}`);
  } catch (error) {
    console.error(`[storeGitHubIndexDocInS3] Error storing index doc ${s3Key}:`, error);
  }
}

// Store edge documents like notifications
async function storeGitHubEdgeDocInS3(userId, edgeType, itemId, doc) {
  console.log(`[storeGitHubEdgeDocInS3] Storing edge doc: ${edgeType} #${itemId} for user ${userId}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[storeGitHubEdgeDocInS3] S3_RAW_BUCKET environment variable is not set.");
    return;
  }
  const safeId = String(itemId).replace(/[^a-zA-Z0-9-_.]/g, '_');
  const s3Key = `raw_data/github/${userId}/_edges/${edgeType}/${safeId}.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(doc, null, 2),
      ContentType: "application/json",
    }));
    console.log(`[storeGitHubEdgeDocInS3] Stored ${s3Key}`);
  } catch (error) {
    console.error(`[storeGitHubEdgeDocInS3] Error storing edge doc ${s3Key}:`, error);
  }
}

// --- DB Helpers for Per-Repository Sync Metadata ---
// Renamed from getUserEventsMetadata
async function getRepoSyncMetadata(dbClient, userId, owner, repoName) {
  const repoKey = `${owner}/${repoName}`;
  console.log(`[getRepoSyncMetadata] Getting sync metadata for UserID: ${userId}, Repo: ${repoKey}`);
  // Path targets connected_apps->'github'->'repositories'->'<owner>/<repoName>'->'sync_metadata'
  const query = `
    SELECT connected_apps->'github'->'repositories'-> $1 -> 'sync_metadata' AS metadata 
    FROM users 
    WHERE id = $2;
  `;
  try {
    const res = await dbClient.query(query, [repoKey, userId]);
    if (res.rows.length > 0 && res.rows[0].metadata && typeof res.rows[0].metadata === 'object') {
       const metadata = res.rows[0].metadata;
       console.log(`[getRepoSyncMetadata] Found metadata for UserID ${userId}, Repo ${repoKey}: ETag: ${metadata.etag}, LastEventID: ${metadata.lastEventId}`);
       return metadata;
    } 
    console.log(`[getRepoSyncMetadata] No metadata found for UserID ${userId}, Repo ${repoKey}.`);
    return { etag: null, lastEventId: null }; 
  } catch (dbError) {
    console.error(`[getRepoSyncMetadata] DB Error fetching metadata for UserID ${userId}, Repo ${repoKey}:`, dbError);
    throw dbError;
  }
}

// Renamed from updateUserEventsMetadata
async function updateRepoSyncMetadata(dbClient, userId, owner, repoName, etag, lastEventId) {
    const repoKey = `${owner}/${repoName}`;
    console.log(`[updateRepoSyncMetadata] Updating sync metadata for UserID: ${userId}, Repo: ${repoKey}, ETag: ${etag}, LastEventId: ${lastEventId}`);
    
    // Path targets connected_apps->'github'->'repositories'->'<owner>/<repoName>'->'sync_metadata'
    // Example path array: ['github', 'repositories', 'owner/repoName', 'sync_metadata']
    const pathArray = ['github', 'repositories', repoKey, 'sync_metadata'];
    const metadataValue = { etag, lastEventId };

    // Ensure parent objects exist ('github', 'repositories', 'owner/repoName')
    // This query robustly creates the nested structure if it doesn't exist.
    const robustUpdateQuery = `
      UPDATE users
      SET connected_apps = jsonb_set(
          jsonb_set(
              jsonb_set(
                  COALESCE(connected_apps, '{}'::jsonb),
                  '{github}', 
                  COALESCE(connected_apps->'github', '{}'::jsonb), 
                  true
              ),
              '{github, repositories}', 
              COALESCE(connected_apps->'github'->'repositories', '{}'::jsonb), 
              true 
          ),
          $1::text[], -- The full path array ['github', 'repositories', 'owner/repoName', 'sync_metadata']
          $2::jsonb, -- The metadata value {etag, lastEventId}
          true -- Create missing keys/objects
      )
      WHERE id = $3;
    `;
    
    try {
      // Note: jsonb_set takes the path as a text array
      await dbClient.query(robustUpdateQuery, [pathArray, JSON.stringify(metadataValue), userId]);
      console.log(`[updateRepoSyncMetadata] Successfully updated metadata for UserID: ${userId}, Repo: ${repoKey}`);
    } catch (dbError) {
      console.error(`[updateRepoSyncMetadata] DB Error updating metadata for UserID: ${userId}, Repo: ${repoKey}:`, dbError);
      throw dbError;
    }
}

// --- Per-User Category Sync Metadata (notifications/search buckets) ---
async function getUserCategorySyncMetadata(dbClient, userId, categoryKey) {
  console.log(`[getUserCategorySyncMetadata] Getting sync metadata for user ${userId}, category ${categoryKey}`);
  const query = `
    SELECT connected_apps->'github'->'sync_metadata'-> $1 AS metadata
    FROM users
    WHERE id = $2;
  `;
  try {
    const res = await dbClient.query(query, [categoryKey, userId]);
    const md = res.rows[0]?.metadata;
    return (md && typeof md === 'object') ? md : null;
  } catch (err) {
    console.error(`[getUserCategorySyncMetadata] DB error:`, err);
    return null;
  }
}

async function updateUserCategorySyncMetadata(dbClient, userId, categoryKey, metadataObj) {
  console.log(`[updateUserCategorySyncMetadata] Updating sync metadata for user ${userId}, category ${categoryKey}`);
  const pathArray = ['github', 'sync_metadata', categoryKey];
  const robustUpdateQuery = `
    UPDATE users
    SET connected_apps = jsonb_set(
        jsonb_set(
            COALESCE(connected_apps, '{}'::jsonb),
            '{github}',
            COALESCE(connected_apps->'github', '{}'::jsonb),
            true
        ),
        $1::text[],
        $2::jsonb,
        true
    )
    WHERE id = $3;
  `;
  try {
    await dbClient.query(robustUpdateQuery, [pathArray, JSON.stringify(metadataObj || {}), userId]);
  } catch (err) {
    console.error(`[updateUserCategorySyncMetadata] DB error:`, err);
  }
}

// --- Lean fetchers ---
async function fetchAndStoreNotifications(dbClient, userId, token) {
  // Use since from metadata or default to 7 days
  const category = 'notifications';
  const md = await getUserCategorySyncMetadata(dbClient, userId, category);
  const defaultSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sinceISO = md?.sinceISO || defaultSince;
  console.log(`[fetchAndStoreNotifications] User ${userId}: since=${sinceISO}`);

  // Fetch all pages
  let notifications = [];
  try {
    const mine = await fetchAllGitHubPages(token, '/notifications', { since: sinceISO, per_page: 100, participating: true });
    const others = await fetchAllGitHubPages(token, '/notifications', { since: sinceISO, per_page: 100, participating: false });
    const byId = new Map();
    for (const n of mine) byId.set(n.id, n);
    for (const n of others) byId.set(n.id, n);
    notifications = Array.from(byId.values());
  } catch (err) {
    console.error(`[fetchAndStoreNotifications] Error fetching notifications: ${err.message}`);
    return;
  }

  let newestUpdatedAt = sinceISO;
  for (const n of notifications) {
    try {
      function toHtmlUrl(apiUrl) {
        if (!apiUrl) return null;
        const m = apiUrl.match(/^(https?:\/\/[^/]+)(?:\/api\/v3)?\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)/);
        if (!m) return null;
        let [ , host, owner, repo, kind, num ] = m;
        host = host.replace('api.github.com', 'github.com');
        const htmlKind = (kind === 'pulls') ? 'pull' : 'issues';
        return `${host}/${owner}/${repo}/${htmlKind}/${num}`;
      }
      const doc = {
        thread_id: n.id,
        reason: n.reason,
        subject: {
          type: n.subject?.type,
          api_url: n.subject?.url,
          html_url: toHtmlUrl(n.subject?.url),
          latest_comment_url: n.subject?.latest_comment_url
        },
        repository: n.repository ? { id: n.repository.id, full_name: n.repository.full_name } : null,
        unread: n.unread,
        updated_at: n.updated_at
      };
      await storeGitHubEdgeDocInS3(userId, 'notifications', n.id, doc);
      if (n.updated_at && n.updated_at > newestUpdatedAt) {
        newestUpdatedAt = n.updated_at;
      }
    } catch (err) {
      console.error(`[fetchAndStoreNotifications] Error storing notification ${n.id}: ${err.message}`);
    }
  }

  // Update metadata
  await updateUserCategorySyncMetadata(dbClient, userId, category, { sinceISO: newestUpdatedAt });
}

function mapRequestedReviewers(nodes) {
  const users = [];
  const teams = [];
  for (const node of nodes || []) {
    if (!node || !node.__typename) continue;
    if (node.__typename === 'User') users.push(node.login);
    if (node.__typename === 'Team') teams.push(`${node.organization?.login}/${node.slug}`);
  }
  return { users, teams };
}

async function graphqlSearchPRs(token, queryString, maxPages = 2) {
  const query = `
    query ($q: String!, $after: String) {
      search(type: ISSUE, query: $q, first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequest {
            id
            number
            title
            url
            updatedAt
            isDraft
            reviewDecision
            mergeable
            changedFiles
            headRefName
            headRefOid
            repository { nameWithOwner }
            author { login }
            statusCheckRollup { state }
            requestedReviewers(first: 10) {
              nodes {
                __typename
                ... on User { login }
                ... on Team { slug organization { login } }
              }
            }
          }
        }
      }
    }
  `;
  let after = null;
  let page = 0;
  const items = [];
  while (page < maxPages) {
    const data = await callGitHubGraphQL(token, query, { q: queryString, after });
    if (!data) break; // soft-failed due to secondary rate limit
    const search = data?.search;
    if (!search || !Array.isArray(search.nodes)) break;
    for (const node of search.nodes) {
      if (node?.__typename === 'PullRequest') items.push(node);
    }
    if (!search.pageInfo?.hasNextPage) break;
    after = search.pageInfo.endCursor;
    page += 1;
  }
  return items;
}

async function graphqlSearchIssues(token, queryString, maxPages = 2) {
  const query = `
    query ($q: String!, $after: String) {
      search(type: ISSUE, query: $q, first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on Issue {
            id
            number
            title
            url
            updatedAt
            repository { nameWithOwner }
            assignees(first: 10) { nodes { login } }
            labels(first: 20) { nodes { name } }
            milestone { dueOn }
          }
        }
      }
    }
  `;
  let after = null;
  let page = 0;
  const items = [];
  while (page < maxPages) {
    const data = await callGitHubGraphQL(token, query, { q: queryString, after });
    if (!data) break; // soft-failed due to secondary rate limit
    const search = data?.search;
    if (!search || !Array.isArray(search.nodes)) break;
    for (const node of search.nodes) {
      if (node?.__typename === 'Issue') items.push(node);
    }
    if (!search.pageInfo?.hasNextPage) break;
    after = search.pageInfo.endCursor;
    page += 1;
  }
  return items;
}

function splitOwnerRepo(nameWithOwner) {
  const [owner, repoName] = String(nameWithOwner || '').split('/')
    .map(s => s.trim());
  return { owner, repoName };
}

async function fetchAndStoreLeanPRIndexes(dbClient, userId, token, userLogin) {
  const nowISO = new Date().toISOString();
  const md = await getUserCategorySyncMetadata(dbClient, userId, 'pr_search_since');
  const sinceISO = md?.sinceISO || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[fetchAndStoreLeanPRIndexes] User ${userId}: since=${sinceISO}`);

  // 1) PRs where review is requested from the user, not draft
  const qReviewRequested = `is:pr is:open review-requested:@me draft:false updated:>=${sinceISO} sort:updated-desc`;
  // 2) PRs authored by me (to compute CHANGES_REQUESTED and failing checks)
  const qAuthored = `is:pr is:open author:@me updated:>=${sinceISO} sort:updated-desc`;

  let reviewRequestedPRs = [];
  let authoredPRs = [];
  try {
    reviewRequestedPRs = await graphqlSearchPRs(token, qReviewRequested, 3);
  } catch (err) {
    console.error(`[fetchAndStoreLeanPRIndexes] Error searching review-requested PRs: ${err.message}`);
  }
  try {
    authoredPRs = await graphqlSearchPRs(token, qAuthored, 3);
  } catch (err) {
    console.error(`[fetchAndStoreLeanPRIndexes] Error searching authored PRs: ${err.message}`);
  }

  const allPRs = [...reviewRequestedPRs, ...authoredPRs];
  const seen = new Set();
  for (const pr of allPRs) {
    if (!pr?.repository?.nameWithOwner) continue;
    const key = `${pr.repository.nameWithOwner}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { owner, repoName } = splitOwnerRepo(pr.repository.nameWithOwner);
    const rr = mapRequestedReviewers(pr.requestedReviewers?.nodes);
    const needsMyReview = (!!userLogin && (rr.users || []).includes(userLogin)) || (rr.teams || []).length > 0; // team resolution can be added later
    const scr = pr.statusCheckRollup?.state;
    const failingChecks = (scr === 'FAILURE' || scr === 'ERROR');
    const changesRequested = (pr.reviewDecision === 'CHANGES_REQUESTED');
    const doc = {
      id: pr.id,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login || null,
      draft: !!pr.isDraft,
      reviewDecision: pr.reviewDecision || null,
      requestedReviewers: rr,
      mergeable: pr.mergeable,
      updatedAt: pr.updatedAt,
      headRefName: pr.headRefName,
      headOid: pr.headRefOid,
      statusCheckRollup: { state: pr.statusCheckRollup?.state || null },
      changedFiles: pr.changedFiles,
      triage: { needsMyReview, failingChecks, changesRequested }
    };
    await storeGitHubIndexDocInS3(userId, 'prs', owner, repoName, pr.number, doc);
  }

  await updateUserCategorySyncMetadata(dbClient, userId, 'pr_search_since', { sinceISO: nowISO });
}

async function fetchAndStoreLeanIssueIndexes(dbClient, userId, token) {
  const nowISO = new Date().toISOString();
  const md = await getUserCategorySyncMetadata(dbClient, userId, 'issue_search_since');
  const sinceISO = md?.sinceISO || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[fetchAndStoreLeanIssueIndexes] User ${userId}: since=${sinceISO}`);

  const qAssigned = `is:issue is:open assignee:@me updated:>=${sinceISO} sort:updated-desc`;
  let issues = [];
  try {
    issues = await graphqlSearchIssues(token, qAssigned, 3);
  } catch (err) {
    console.error(`[fetchAndStoreLeanIssueIndexes] Error searching assigned issues: ${err.message}`);
  }

  for (const issue of issues) {
    if (!issue?.repository?.nameWithOwner) continue;
    const { owner, repoName } = splitOwnerRepo(issue.repository.nameWithOwner);
    const doc = {
      id: issue.id,
      repo: issue.repository.nameWithOwner,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      assignees: (issue.assignees?.nodes || []).map(u => u.login),
      labels: (issue.labels?.nodes || []).map(l => l.name),
      milestone: issue.milestone ? { due_on: issue.milestone.dueOn } : null,
      updated_at: issue.updatedAt
    };
    await storeGitHubIndexDocInS3(userId, 'issues', owner, repoName, issue.number, doc);
  }

  await updateUserCategorySyncMetadata(dbClient, userId, 'issue_search_since', { sinceISO: nowISO });
}

// --- Per-User GitHub Data Processing (Lean) ---
async function processUserGitHubData(user, dbClient) {
  console.log(`[processUserGitHubData] START lean GitHub sync for UserID: ${user.id}`);

  if (!user.github || !user.github.accessToken || !user.github.login) {
    console.warn(`[processUserGitHubData] User ${user.id} missing GitHub token, login, or github object. Skipping.`);
    return;
  }
  const userId = user.id;
  const token = user.github.accessToken;
  const userLogin = user.github.login; // kept for potential future filters

  try {
    // Cheap front door: notifications
    await fetchAndStoreNotifications(dbClient, userId, token);

    // Focused PR index
    await fetchAndStoreLeanPRIndexes(dbClient, userId, token, userLogin);
    // Focused Issue index
    await fetchAndStoreLeanIssueIndexes(dbClient, userId, token);

    // Optional: repositories/orgs summary for UX/reference (cheap)
    try {
      const [repositories, organizations] = await Promise.all([
        fetchUserRepositories(token),
        fetchUserOrganizations(token)
      ]);
      await storeGitHubUserSummaryDataInS3(userId, 'repositories', repositories);
      await storeGitHubUserSummaryDataInS3(userId, 'organizations', organizations);
    } catch (summaryErr) {
      console.warn(`[processUserGitHubData] Summary fetch/store failed (non-fatal): ${summaryErr.message}`);
    }

  } catch (error) {
    console.error(`[processUserGitHubData] User ${userId}: Top-level error during lean sync: ${error.message}`, error);
  }
  console.log(`[processUserGitHubData] END lean GitHub sync for UserID: ${userId}.`);
}


// --- Main Handler ---
exports.handler = async (event, context) => {
  console.log(`[GitHubSync Handler] Starting GitHub sync at ${new Date().toISOString()}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[GitHubSync Handler] Critical: S3_RAW_BUCKET environment variable is not set. Aborting.");
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
        AND connected_apps->'github'->>'login' IS NOT NULL -- Ensure login is stored
        AND is_disabled = false
    `;
    const userQueryRes = await client.query(sqlQuery);
    
    const users = userQueryRes.rows.map(row => {
      return {
        id: row.id,
        github: typeof row.github === "string" ? JSON.parse(row.github) : row.github,
      };
    });

    if (users.length === 0) {
      console.log("[GitHubSync Handler] No users with active GitHub connection (incl. login) found.");
      return { statusCode: 200, body: "No GitHub users to sync." };
    }
    console.log(`[GitHubSync Handler] Found ${users.length} user(s) with GitHub connection to process.`);

    for (const user of users) {
      console.log(`[GitHubSync Handler] Processing User ID: ${user.id}`);
      if (!user.github || typeof user.github !== 'object' || !user.github.accessToken || !user.github.login) {
          // Double check here although query should prevent this
          console.warn(`[GitHubSync Handler] User ${user.id} has invalid/missing GitHub credentials (token or login). Skipping.`);
          continue;
      }
      await processUserGitHubData(user, client);
      console.log(`[GitHubSync Handler] Finished processing User ID: ${user.id}`);
    }
    console.log("[GitHubSync Handler] GitHub sync completed successfully.");
    return { statusCode: 200, body: "GitHub sync completed successfully." };
  } catch (err) {
    console.error("[GitHubSync Handler] Global error in handler:", err);
    return { statusCode: 500, body: "Error in GitHub sync." };
  } finally {
    if (client) {
      client.release();
    }
  }
};
