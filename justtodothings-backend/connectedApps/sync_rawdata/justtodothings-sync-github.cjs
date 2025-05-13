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
  console.log(`[callGitHubApi] Calling Endpoint: ${endpoint}, ETag: ${etag}`);
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
    console.log(`[callGitHubApi] Success for ${endpoint}. Status: ${response.status}, ETag: ${response.headers.etag}, Data Length: ${response.data ? (Array.isArray(response.data) ? response.data.length : 'N/A') : 'N/A'}`);
    return { data: response.data, etag: response.headers.etag, status: response.status };
  } catch (error) {
    if (error.response) {
        console.error(`[callGitHubApi] Error for ${url}. Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        if (error.response.status === 304) {
            console.log(`[callGitHubApi] Status 304 (Not Modified) for ${endpoint}. ETag: ${error.response.headers.etag}`);
            return { data: null, etag: error.response.headers.etag, status: 304 };
        }
        if (error.response.status === 401) {
            console.error(`[callGitHubApi] GitHub API Unauthorized (401) for endpoint ${endpoint}.`);
            throw new Error(`GitHub API Unauthorized (401) for endpoint ${endpoint}. Token might be invalid.`);
        }
        if (error.response.status === 403) {
            console.warn(`[callGitHubApi] GitHub API Forbidden (403) for endpoint ${endpoint}. Rate limits or permissions?`);
            throw new Error(`GitHub API Forbidden (403) for endpoint ${endpoint}.`);
        }
    } else {
        console.error(`[callGitHubApi] Network/Request Error for ${url}: ${error.message}`);
    }
    throw error;
  }
}

// Helper to handle GitHub API pagination
async function fetchAllGitHubPages(token, endpoint, params = {}) {
  let items = [];
  let url = `${GITHUB_API_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  let page = 1; // GitHub API pagination is 1-based

  console.log(`[fetchAllGitHubPages] Starting pagination for ${endpoint}`);

  while (url) {
    try {
      console.log(`[fetchAllGitHubPages] Fetching page ${page} for ${endpoint}`);
      const response = await axios.get(url, { 
          headers, 
          params: { ...params, page: page, per_page: 100 } // Use 100 per page for efficiency 
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
      console.error(`[fetchAllGitHubPages] Error fetching page ${page} for ${endpoint}: ${error.message}`);
      if (error.response) {
          console.error(`[fetchAllGitHubPages] Error details: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
      }
      // Decide how to handle errors - stop pagination or retry? For now, stop.
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
          $1, -- The full path array ['github', 'repositories', 'owner/repoName', 'sync_metadata']
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

// --- Per-User GitHub Data Processing (Refactored) ---
async function processUserGitHubData(user, dbClient) {
  console.log(`[processUserGitHubData] START Processing GitHub data for UserID: ${user.id} using per-repository event fetching.`);

  if (!user.github || !user.github.accessToken || !user.github.login) {
    console.warn(`[processUserGitHubData] User ${user.id} missing GitHub token, login, or github object. Skipping. GitHub creds: ${JSON.stringify(user.github)}`);
    return;
  }
  const userId = user.id;
  const token = user.github.accessToken;
  const userLogin = user.github.login; // Get the GitHub login from the stored data

  try {
    // 1. Fetch Foundational Data
    console.log(`[processUserGitHubData] User ${userId}: Fetching repositories and organizations.`);
    const repositories = await fetchUserRepositories(token);
    const organizations = await fetchUserOrganizations(token);

    // 2. Store Foundational Data in S3
    await storeGitHubUserSummaryDataInS3(userId, 'repositories', repositories);
    await storeGitHubUserSummaryDataInS3(userId, 'organizations', organizations);

    if (!repositories || repositories.length === 0) {
      console.log(`[processUserGitHubData] User ${userId}: No accessible repositories found. Nothing to sync.`);
      return;
    }

    console.log(`[processUserGitHubData] User ${userId}: Found ${repositories.length} repositories. Starting per-repo event sync.`);

    // 3. Loop Through Repositories and Fetch/Process Events
    for (const repo of repositories) {
      const repoFullName = repo.full_name; // Format: owner/repo
      const repoParts = repoFullName.split('/');
      if (repoParts.length !== 2) {
        console.warn(`[processUserGitHubData] User ${userId}: Skipping repo with invalid name format: ${repoFullName}`);
        continue;
      }
      const owner = repoParts[0];
      const repoName = repoParts[1];
      console.log(`[processUserGitHubData] --- Processing Repo: ${repoFullName} for User ${userId} ---`);

      // Get sync metadata for this specific repository
      const storedRepoMeta = await getRepoSyncMetadata(dbClient, userId, owner, repoName);
      let currentRepoEtag = storedRepoMeta.etag;
      let lastProcessedRepoEventId = storedRepoMeta.lastEventId;
      let newLastRepoEventIdInPage = null; // Track the newest event ID encountered in this page for this repo

      try {
        console.log(`[processUserGitHubData] Repo ${repoFullName}: Fetching events. ETag: ${currentRepoEtag}`);
        // Fetch events for this specific repository
        const repoEventResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/events`, { per_page: 100 }, currentRepoEtag);
        
        if (repoEventResponse.status === 304) {
          console.log(`[processUserGitHubData] Repo ${repoFullName}: Events not modified (304). Skipping.`);
          continue; // Move to the next repository
        }

        // Update ETag for this repo based on the response
        currentRepoEtag = repoEventResponse.etag;
        const repoEvents = repoEventResponse.data;

        if (repoEvents && repoEvents.length > 0) {
          console.log(`[processUserGitHubData] Repo ${repoFullName}: Fetched ${repoEvents.length} raw event(s).`);
          // The first event in the list is the most recent one
          newLastRepoEventIdInPage = repoEvents[0].id; 

          // Process the fetched events for this repository
          for (const event of repoEvents) { 
            console.log(`[processUserGitHubData] Repo ${repoFullName}: Processing Event ID: ${event.id}, Type: ${event.type}`);
            
            // Stop processing events for THIS REPO if we reach the last processed ID for THIS REPO
            if (event.id === lastProcessedRepoEventId) {
              console.log(`[processUserGitHubData] Repo ${repoFullName}: Reached last processed event ID (${event.id}). Stopping processing for this repo.`);
              break; // Stop processing events for this repo page
            }

            // Store the raw event keyed by repo
            // Owner and repoName are already defined from the outer loop
            await storeGitHubDataItemInS3(userId, owner, repoName, "events", event.id, event);

            // Fetch and store full details based on event type
            // (The detailed fetching logic from the previous edit is used here)
            try { 
              if (event.type === 'PushEvent' && event.payload.commits) {
                console.log(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Found PushEvent with ${event.payload.commits.length} commit(s).`);
                for (const commitStub of event.payload.commits) {
                  try {
                    // Fetch full commit details (already does this)
                    const commitDetailsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/commits/${commitStub.sha}`);
                    if (commitDetailsResponse.status !== 304 && commitDetailsResponse.data) {
                      console.log(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Storing commit details for SHA ${commitStub.sha}.`);
                      await storeGitHubDataItemInS3(userId, owner, repoName, "commits", commitStub.sha, commitDetailsResponse.data);
                    } 
                  } catch (commitErr) { console.error(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Error fetching commit ${commitStub.sha}: ${commitErr.message}`); }
                }
              } else if ((event.type === 'IssuesEvent' || event.type === 'IssueCommentEvent') && event.payload.issue) {
                const issueNumber = event.payload.issue.number;
                console.log(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Found ${event.type} for issue #${issueNumber}`);
                try {
                    // Fetch issue details and comments (already does this)
                    const issueDetailsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/issues/${issueNumber}`);
                    if (issueDetailsResponse.status !== 304 && issueDetailsResponse.data) {
                        let issueData = issueDetailsResponse.data;
                        console.log(`[processUserGitHubData] Repo ${repoFullName}, Issue #${issueNumber}: Fetched base details. Fetching comments...`);
                        try {
                            const commentsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/issues/${issueNumber}/comments`);
                            if (commentsResponse.data) {
                                issueData.comments_list = commentsResponse.data;
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, Issue #${issueNumber}: Fetched ${commentsResponse.data.length} comments.`);
                            }
                        } catch (commentsErr) {
                            console.error(`[processUserGitHubData] Repo ${repoFullName}, Issue #${issueNumber}: Error fetching comments: ${commentsErr.message}`);
                        }
                        console.log(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Storing issue details for #${issueNumber}.`);
                        await storeGitHubDataItemInS3(userId, owner, repoName, "issues", issueNumber, issueData); 
                    }
                } catch (issueErr) { console.error(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Error fetching issue ${issueNumber}: ${issueErr.message}`); }
              } else if ((event.type === 'PullRequestEvent' || event.type === 'PullRequestReviewEvent' || event.type === 'PullRequestReviewCommentEvent') && event.payload.pull_request) {
                const prNumber = event.payload.pull_request.number;
                console.log(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Found ${event.type} for PR #${prNumber}`);
                try {
                    // Fetch PR details, comments, reviews, diff, full commits (already does this)
                    const prDetailsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/pulls/${prNumber}`);
                    if (prDetailsResponse.status !== 304 && prDetailsResponse.data) {
                        let prData = prDetailsResponse.data;
                        console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Fetched base details. Fetching commits, comments, reviews & diff...`);
                        
                        // Fetch PR Commits (Full Details)
                        try {
                            const prCommitsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/pulls/${prNumber}/commits`);
                            if (prCommitsResponse.data) {
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Fetched ${prCommitsResponse.data.length} commit stubs. Fetching full details...`);
                                const detailedCommits = [];
                                for (const commitStub of prCommitsResponse.data) {
                                    try {
                                        const commitDetailsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/commits/${commitStub.sha}`);
                                        if (commitDetailsResponse.status !== 304 && commitDetailsResponse.data) {
                                            detailedCommits.push(commitDetailsResponse.data);
                                        } else if(commitDetailsResponse.status === 304) {
                                            console.warn(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Commit ${commitStub.sha} fetch resulted in 304 (Not Modified). This shouldn't typically happen here.`);
                                        }
                                    } catch (commitDetailErr) {
                                        console.error(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Error fetching full commit details for SHA ${commitStub.sha}: ${commitDetailErr.message}`);
                                    }
                                }
                                prData.commits_list_full = detailedCommits;
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Successfully fetched details for ${detailedCommits.length} commits.`);
                            }
                        } catch (prCommitsErr) {
                            console.error(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Error fetching commits list: ${prCommitsErr.message}`);
                        }
                        
                        // Fetch PR General Comments (Issue Comments API)
                        try {
                            const issueCommentsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/issues/${prNumber}/comments`);
                            if (issueCommentsResponse.data) {
                                prData.general_comments_list = issueCommentsResponse.data;
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Fetched ${issueCommentsResponse.data.length} general comments.`);
                            }
                        } catch (prIssueCommentsErr) {
                            console.error(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Error fetching general comments (via issues API): ${prIssueCommentsErr.message}`);
                        }
                        
                        // Fetch PR Review Comments
                        try {
                            const reviewCommentsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/pulls/${prNumber}/comments`);
                            if (reviewCommentsResponse.data) {
                                prData.review_comments_list = reviewCommentsResponse.data;
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Fetched ${reviewCommentsResponse.data.length} review comments.`);
                            }
                        } catch (prReviewCommentsErr) {
                            console.error(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Error fetching review comments: ${prReviewCommentsErr.message}`);
                        }

                        // Fetch PR Formal Reviews
                        try {
                            const reviewsResponse = await callGitHubApi(token, `/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`);
                            if (reviewsResponse.data) {
                                prData.reviews_list = reviewsResponse.data;
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Fetched ${reviewsResponse.data.length} formal reviews.`);
                            }
                        } catch (prReviewsErr) {
                            console.error(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Error fetching formal reviews: ${prReviewsErr.message}`);
                        }

                        // Fetch PR Diff
                        try {
                            const prDiffResponse = await axios.get(`${GITHUB_API_BASE_URL}/repos/${owner}/${repoName}/pulls/${prNumber}`, {
                                headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' }
                            });
                            if (prDiffResponse.data) {
                                prData.diff = prDiffResponse.data;
                                console.log(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Fetched diff.`);
                            }
                        } catch (prDiffErr) {
                            console.error(`[processUserGitHubData] Repo ${repoFullName}, PR #${prNumber}: Error fetching diff: ${prDiffErr.response?.data || prDiffErr.message}`);
                        }

                        console.log(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Storing PR #${prNumber} data.`);
                        await storeGitHubDataItemInS3(userId, owner, repoName, "pull_requests", prNumber, prData); 
                    }
                } catch (prErr) { console.error(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id}: Error fetching PR ${prNumber}: ${prErr.message}`); }
              }
              // Add other event types here if needed (CreateEvent, DeleteEvent, etc.)

            } catch (detailFetchError) {
              console.error(`[processUserGitHubData] Repo ${repoFullName}, Event ${event.id} (${event.type}): General error during detail fetching: ${detailFetchError.message}`);
            }
          } // End event loop for this repository

          // Update metadata for this repository if new events were processed
          if (newLastRepoEventIdInPage && newLastRepoEventIdInPage !== lastProcessedRepoEventId) {
            console.log(`[processUserGitHubData] Repo ${repoFullName}: Updating sync metadata. New LastEventID: ${newLastRepoEventIdInPage}, ETag: ${currentRepoEtag}`);
            await updateRepoSyncMetadata(dbClient, userId, owner, repoName, currentRepoEtag, newLastRepoEventIdInPage);
          } else if (currentRepoEtag !== storedRepoMeta.etag) {
            // If only the ETag changed (e.g., empty events list but not 304), update the ETag only
            console.log(`[processUserGitHubData] Repo ${repoFullName}: Updating sync metadata. ETag changed to ${currentRepoEtag} (no new events processed).`);
            await updateRepoSyncMetadata(dbClient, userId, owner, repoName, currentRepoEtag, lastProcessedRepoEventId); 
          }

        } else {
          // No new events fetched for this repo (but not a 304)
          console.log(`[processUserGitHubData] Repo ${repoFullName}: No new events fetched (API status ${repoEventResponse.status}).`);
          // Update ETag only if it changed and we didn't get a 304 response
          if (currentRepoEtag !== storedRepoMeta.etag) {
            console.log(`[processUserGitHubData] Repo ${repoFullName}: Updating sync metadata. ETag changed to ${currentRepoEtag} (no new events).`);
            await updateRepoSyncMetadata(dbClient, userId, owner, repoName, currentRepoEtag, lastProcessedRepoEventId); 
          }
        }

      } catch (repoError) {
        console.error(`[processUserGitHubData] Repo ${repoFullName}: Failed processing events: ${repoError.message}`, repoError);
        // Decide if we should continue with the next repo or stop. Continuing for now.
      }

      console.log(`[processUserGitHubData] --- Finished Processing Repo: ${repoFullName} for User ${userId} ---`);

    } // End repository loop

  } catch (error) {
    console.error(`[processUserGitHubData] User ${userId}: Top-level error during processing: ${error.message}`, error);
  }
  console.log(`[processUserGitHubData] END GitHub data processing for UserID: ${userId}.`);
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
