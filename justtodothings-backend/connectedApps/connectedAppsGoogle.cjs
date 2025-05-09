"use strict";

const AWS = require("aws-sdk");
const { Pool } = require("pg");
const axios = require("axios");
const crypto = require("crypto");
const { google } = require("googleapis");

// Environment variables (set in AWS console or via Parameter Store/Secrets Manager):
//   DATABASE_URL
//   S3_RAW_BUCKET
//   OPENAI_API_KEY
//   OPENAI_MODEL

// Optionally, store client secrets in environment variables, or in connected_apps JSON per user:
//   GMAIL_CLIENT_ID
//   GMAIL_CLIENT_SECRET
//   (or fetch them from Secrets Manager)

const s3 = new AWS.S3();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---------- Helper Functions ----------

// Attach stable source_id to each Gmail message.
function attachStableIds(gmailData) {
  // gmailData is an array of message objects with { id, threadId, snippet, payload, ... }
  // We add a 'source_id' field like "gmail-<messageId>"
  gmailData.forEach(msg => {
    msg.source_id = `gmail-${msg.id}`;
  });
  return gmailData;
}

// Retrieve previous aggregated data from S3 and compute a delta.
async function computeDelta(newData, bucketName, userId) {
  const key = `raw-data/gmail/${userId}/latest.json`;
  let oldData;

  try {
    const existing = await s3.getObject({ Bucket: bucketName, Key: key }).promise();
    oldData = JSON.parse(existing.Body.toString("utf-8"));
  } catch (err) {
    if (err.code === "NoSuchKey") {
      console.log(`[GmailSync] No previous data for user ${userId}; first sync.`);
      return newData; // Everything is new.
    }
    throw err;
  }

  // Build a set of source_ids from old data.
  const oldSourceIds = new Set(oldData.map(item => item.source_id));

  // Filter out items already present
  const deltaData = newData.filter(item => !oldSourceIds.has(item.source_id));
  return deltaData;
}

// Upsert tasks into the database using the stable source_id.
async function upsertTasks(client, userId, todos) {
  const now = new Date().toISOString();
  for (const todo of todos) {
    const { title, description, due_date, source_id } = todo;
    if (!title || !source_id) continue;

    const query = `
      INSERT INTO tasks (user_id, title, description, priority, due_date, created_at, updated_at, source_id)
      VALUES ($1, $2, $3, 'medium', $4, $5, $5, $6)
      ON CONFLICT (user_id, source_id) DO NOTHING
      RETURNING id
    `;
    const values = [userId, title.trim(), description ? description.trim() : "", due_date || null, now, source_id];

    try {
      await client.query(query, values);
    } catch (err) {
      console.error(`[GmailSync] Error upserting task for user ${userId} (source_id: ${source_id}): ${err.message}`);
    }
  }
}

// ---------- Gmail Data Fetching ----------

async function fetchGmailData(userId, gmailCreds) {
  // gmailCreds might look like: { accessToken, refreshToken, ... }
  // We'll use googleapis to fetch messages
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    "api.justtodothings.com/connectedApps/gmail/callback"
  );
  oauth2Client.setCredentials({
    access_token: gmailCreds.accessToken,
    refresh_token: gmailCreds.refreshToken,
  });

  // Attempt token refresh if needed
  // googleapis automatically refreshes if the token is expired,
  // but you can also manually handle refresh if you want to store new tokens in DB.
  // e.g., let newTokens = await oauth2Client.getAccessToken() { ... update DB ... }

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // 1. List messages
  // For example, we fetch the last 50 messages from the inbox
  // Adjust query or maxResults as needed
  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 50,
    q: "", // e.g., you can filter by date or label
  });

  if (!listRes.data.messages) {
    console.log(`[GmailSync] User ${userId} has no messages to process.`);
    return [];
  }

  const messages = listRes.data.messages; // array of { id, threadId }

  // 2. Fetch message details in parallel
  // Make sure not to exceed rate limits. For demonstration, we do Promise.all
  const messageDetails = await Promise.all(
    messages.map(async (msg) => {
      try {
        const msgRes = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
        // Return relevant fields
        return {
          id: msg.id,
          threadId: msg.threadId,
          snippet: msgRes.data.snippet || "",
          payload: msgRes.data.payload || {},
          internalDate: msgRes.data.internalDate || null,
        };
      } catch (err) {
        console.warn(`[GmailSync] Failed to fetch message ${msg.id} for user ${userId}: ${err.message}`);
        return null;
      }
    })
  );

  // Filter out null (failed fetches)
  return messageDetails.filter(m => m !== null);
}

// ---------- ChatGPT Analysis ----------

async function analyzeWithChatGPT(gmailData) {
  const prompt = buildChatGPTPrompt(gmailData);

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL || "gpt-4o-2024-08-06",
        messages: [
          {
            role: "system",
            content: "You are an assistant that summarizes Gmail messages into concise to-do items. Return only actionable tasks.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.trim();
    const todos = JSON.parse(content);
    if (!Array.isArray(todos)) {
      throw new Error("ChatGPT response did not return an array of todos.");
    }
    console.log(`[GmailSync] ChatGPT returned ${todos.length} todos.`);
    return todos;
  } catch (err) {
    throw new Error(`[GmailSync] Error analyzing data with ChatGPT: ${err.message}`);
  }
}

function buildChatGPTPrompt(gmailData) {
  // Keep data short to avoid token limit
  // For each message, we might pass snippet, subject, from, date, etc.
  const snippet = JSON.stringify(gmailData).slice(0, 6000);
  return `
  Below is an array of recent Gmail messages in JSON format. Each message has:
  - 'id' (unique message ID)
  - 'threadId'
  - 'snippet' (short excerpt)
  - 'payload' (full email content, headers, body)
  - 'source_id' (like 'gmail-<messageId>')

  Your job:
  1. Identify if there's a clear action or event. (e.g. an interview time, a deadline, a test invite).
  2. If so, create a JSON array of to-do objects. Each object must have:
     {
       "source_id": string (exactly match the message's source_id),
       "title": string,
       "description": string,
       "due_date": string or null (ISO8601 if possible)
     }
  3. Only create to-dos if there's a real action. If it's just info or an ad, skip it.
  4. Return valid JSON only, no extra text.

  Gmail data:
  ${snippet}
  `;
}

// ---------- Process One User's Gmail Data ----------

async function processUserGmailData(user) {
  const { id: userId, gmail } = user;
  if (!gmail.accessToken) {
    throw new Error(`User ${userId} is missing Gmail accessToken.`);
  }

  // 1. Fetch Gmail data
  let rawEmails = await fetchGmailData(userId, gmail);
  if (rawEmails.length === 0) {
    console.log(`[GmailSync] User ${userId} has no emails to process.`);
    return;
  }

  // 2. Attach stable IDs
  rawEmails = attachStableIds(rawEmails);

  // 3. Delta check (optional, if you want to store raw data in S3)
  let deltaEmails = rawEmails;
  if (process.env.S3_RAW_BUCKET) {
    deltaEmails = await computeDelta(rawEmails, process.env.S3_RAW_BUCKET, userId);

    // Always store the new aggregated data in S3 for reference
    await s3.putObject({
      Bucket: process.env.S3_RAW_BUCKET,
      Key: `raw-data/gmail/${userId}/latest.json`,
      Body: JSON.stringify(rawEmails, null, 2),
      ContentType: "application/json",
    }).promise();
  }

  if (deltaEmails.length === 0) {
    console.log(`[GmailSync] No new Gmail items for user ${userId}; skipping ChatGPT analysis.`);
    return;
  }

  // 4. Analyze the delta with ChatGPT
  const todos = await analyzeWithChatGPT(deltaEmails);

  // 5. Upsert the generated to-dos into the tasks table
  const client = await pool.connect();
  try {
    await upsertTasks(client, userId, todos);
  } finally {
    client.release();
  }
}

// ---------- Main Handler ----------

exports.handler = async (event, context) => {
  console.log(`[GmailSync] Starting sync at ${new Date().toISOString()}`);
  try {
    const client = await pool.connect();
    let users = [];
    try {
      const res = await client.query(`
        SELECT id, connected_apps->'gmail' AS gmail
        FROM users
        WHERE connected_apps->'gmail' IS NOT NULL
          AND is_disabled = false
      `);
      users = res.rows.map(row => ({
        id: row.id,
        gmail: typeof row.gmail === "string" ? JSON.parse(row.gmail) : row.gmail,
      }));
    } finally {
      client.release();
    }

    if (users.length === 0) {
      console.log("[GmailSync] No users with Gmail connected.");
      return { statusCode: 200, body: "No Gmail users found." };
    }

    for (const user of users) {
      try {
        await processUserGmailData(user);
        console.log(`[GmailSync] User ${user.id} processed successfully.`);
      } catch (err) {
        console.error(`[GmailSync] Error processing user ${user.id}: ${err.message}`);
      }
    }

    return { statusCode: 200, body: "Gmail sync completed." };
  } catch (err) {
    console.error("[GmailSync] Global error:", err);
    return { statusCode: 500, body: "Error in Gmail sync." };
  }
};
