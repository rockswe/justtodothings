"use strict";

const AWS = require("aws-sdk");
const { Pool } = require("pg");
const axios = require("axios");
const crypto = require("crypto");

const s3 = new AWS.S3();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---------- Helper Functions ----------

// Attach a stable source_id to each Canvas item.
function attachStableIds(aggregatedData) {
  aggregatedData.forEach(course => {
    if (course.assignments) {
      course.assignments = course.assignments.map(item => ({
        ...item,
        source_id: `assignment-${item.id}`, // Canvas assignment ID is stable.
      }));
    }
    if (course.announcements) {
      course.announcements = course.announcements.map(item => ({
        ...item,
        source_id: item.id 
          ? `announcement-${item.id}` 
          : `announcement-${item.created_at}-${item.title.replace(/\s+/g, "")}`,
      }));
    }
    if (course.modules) {
      course.modules = course.modules.map(module => ({
        ...module,
        items: module.items.map(item => ({
          ...item,
          source_id: item.id 
            ? `moduleItem-${item.id}` 
            : `moduleItem-${course.course.id}-${item.title.replace(/\s+/g, "")}`,
        })),
      }));
    }
  });
  return aggregatedData;
}

// Compute a SHA256 hash for an object.
function computeHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

// Retrieve previous aggregated data from S3 and compute a delta.
async function computeDelta(newData, bucketName, userId) {
  const key = `raw-data/canvas/${userId}/latest.json`;
  let oldData;
  try {
    const existing = await s3.getObject({ Bucket: bucketName, Key: key }).promise();
    oldData = JSON.parse(existing.Body.toString("utf-8"));
  } catch (err) {
    if (err.code === "NoSuchKey") {
      console.log(`No previous data for user ${userId}; first sync.`);
      return newData; // Everything is new.
    }
    throw err;
  }
  // Build a set of source_ids from old data.
  const oldSourceIds = new Set();
  oldData.forEach(course => {
    if (course.assignments) {
      course.assignments.forEach(item => oldSourceIds.add(item.source_id));
    }
    if (course.announcements) {
      course.announcements.forEach(item => oldSourceIds.add(item.source_id));
    }
    if (course.modules) {
      course.modules.forEach(module => {
        module.items.forEach(item => oldSourceIds.add(item.source_id));
      });
    }
  });
  // Deep clone newData and remove items already seen.
  const deltaData = JSON.parse(JSON.stringify(newData));
  deltaData.forEach(course => {
    if (course.assignments) {
      course.assignments = course.assignments.filter(item => !oldSourceIds.has(item.source_id));
    }
    if (course.announcements) {
      course.announcements = course.announcements.filter(item => !oldSourceIds.has(item.source_id));
    }
    if (course.modules) {
      course.modules.forEach(module => {
        module.items = module.items.filter(item => !oldSourceIds.has(item.source_id));
      });
    }
  });
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
      console.error(`Error upserting task for user ${userId} (source_id: ${source_id}): ${err.message}`);
    }
  }
}

// ---------- Canvas Data Fetching ----------

async function fetchCanvasData(domain, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://${domain}/api/v1`;
  const now = new Date().toISOString();

  // 1. Fetch Courses
  let courses;
  try {
    const res = await axios.get(`${baseUrl}/users/self/courses`, {
      headers,
      params: {
        "state[]": "available",
        enrollment_state: "active",
        "include[]": "term",
        per_page: 100,
      },
    });
    courses = res.data.filter(course =>
      course.term &&
      course.term.start_at &&
      course.term.end_at &&
      course.term.start_at <= now &&
      course.term.end_at >= now
    ).map(course => ({
      id: course.id,
      name: course.name,
      term_name: course.term.name,
    }));
    console.log(`Fetched ${courses.length} courses.`);
  } catch (err) {
    throw new Error(`Error fetching courses: ${err.message}`);
  }

  // 2. For each course, fetch additional data.
  const aggregatedData = [];
  for (const course of courses) {
    let announcements = [];
    let assignments = [];
    let modules = [];
    try {
      const annRes = await axios.get(`${baseUrl}/announcements`, {
        headers,
        params: {
          "context_codes[]": `course_${course.id}`,
          start_date: "2025-01-01",
          end_date: "2032-12-31",
          per_page: 100,
        },
      });
      announcements = annRes.data.map(item => ({
        id: item.id, // if provided by Canvas
        title: item.title,
        message: item.message,
        created_at: item.created_at,
        author_display_name: item.author ? item.author.display_name : null,
      }));
      console.log(`Course ${course.id}: Fetched ${announcements.length} announcements.`);
    } catch (err) {
      console.warn(`Course ${course.id}: Error fetching announcements: ${err.message}`);
    }
    try {
      const assignRes = await axios.get(`${baseUrl}/courses/${course.id}/assignments`, {
        headers,
        params: {
          "include[]": ["submission", "overrides", "score_statistics"],
        },
      });
      assignments = assignRes.data.map(assignment => ({
        id: assignment.id,
        name: assignment.name,
        description: assignment.description
          ? assignment.description.replace(/<[^>]+>/g, " ").replace(/\n/g, " ").replace(/\u00A0/g, " ")
          : "",
        due_at: assignment.due_at,
        lock_at: assignment.lock_at,
        points_possible: assignment.points_possible,
        grade: assignment.submission ? assignment.submission.grade : null,
        score: assignment.submission ? assignment.submission.score : null,
      }));
      console.log(`Course ${course.id}: Fetched ${assignments.length} assignments.`);
    } catch (err) {
      console.warn(`Course ${course.id}: Error fetching assignments: ${err.message}`);
    }
    try {
      const modulesRes = await axios.get(`${baseUrl}/courses/${course.id}/modules`, {
        headers,
        params: {
          "include[]": ["items", "content_details"],
          per_page: 100,
        },
      });
      modules = modulesRes.data.map(module => ({
        module_name: module.name,
        items: module.items ? module.items.map(item => ({
          id: item.id,
          title: item.title,
          type: item.type,
          url: item.html_url,
          due_date: item.content_details ? item.content_details.due_at || null : null,
          points: item.content_details ? item.content_details.points_possible || null : null,
        })) : [],
      }));
      console.log(`Course ${course.id}: Fetched ${modules.length} modules.`);
    } catch (err) {
      console.warn(`Course ${course.id}: Error fetching modules: ${err.message}`);
    }
    aggregatedData.push({
      course,
      announcements,
      assignments,
      modules,
    });
  }
  return aggregatedData;
}


async function analyzeWithChatGPT(aggregatedData) {
  const prompt = buildChatGPTPrompt(aggregatedData);
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL || "gpt-4o-2024-08-06",
        messages: [
          {
            role: "system",
            content: "You are an assistant that summarizes Canvas course data into concise to-do items. For each item, return the same source_id provided.",
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
    console.log(`ChatGPT returned ${todos.length} todos.`);
    return todos;
  } catch (err) {
    throw new Error(`Error analyzing data with ChatGPT: ${err.message}`);
  }
}

function buildChatGPTPrompt(aggregatedData) {
  // Truncate data to avoid token limits.
  const dataSnippet = JSON.stringify(aggregatedData).slice(0, 6000);
  return `
    Here is the aggregated Canvas data in JSON format:
    ${dataSnippet}
    Analyze this data and generate a JSON array of to-do items.
    Each to-do item must have the following keys: "source_id", "title", "description", "due_date".
    Ensure that the "source_id" in your output matches the one provided in the input.
    Return only valid JSON.
  `;
}

// ---------- Process users Canvas Data ----------

async function processUserCanvasData(user) {
  const { id: userId, canvas } = user;
  if (!canvas.domain || !canvas.accessToken) {
    throw new Error(`User ${userId} is missing Canvas credentials.`);
  }
  let aggregatedData = await fetchCanvasData(canvas.domain, canvas.accessToken);
  aggregatedData = attachStableIds(aggregatedData);
  
  // Compute the delta (new items only) relative to previous sync.
  const deltaData = await computeDelta(aggregatedData, process.env.S3_RAW_BUCKET, userId);
  
  // Always update the latest aggregated data in S3.
  await s3.putObject({
    Bucket: process.env.S3_RAW_BUCKET,
    Key: `raw-data/canvas/${userId}/latest.json`,
    Body: JSON.stringify(aggregatedData, null, 2),
    ContentType: "application/json",
  }).promise();
  
  // If the delta is effectively empty (no new source_ids), skip ChatGPT.
  const hasNewItems = deltaData.some(course =>
    (course.assignments && course.assignments.length > 0) ||
    (course.announcements && course.announcements.length > 0) ||
    (course.modules && course.modules.some(module => module.items.length > 0))
  );
  
  if (!hasNewItems) {
    console.log(`No new Canvas items for user ${userId}; skipping ChatGPT analysis.`);
    return;
  }
  
  // Analyze the delta data with ChatGPT to generate to-dos.
  const todos = await analyzeWithChatGPT(deltaData);
  
  // Upsert the generated to-dos into the tasks table.
  const client = await pool.connect();
  try {
    await upsertTasks(client, userId, todos);
  } finally {
    client.release();
  }
}

// ---------- Main Handler ----------

exports.handler = async (event, context) => {
  try {
    const client = await pool.connect();
    let users = [];
    try {
      const res = await client.query(`
        SELECT id, connected_apps->'canvas' AS canvas
        FROM users
        WHERE connected_apps->'canvas' IS NOT NULL
          AND is_disabled = false
      `);
      users = res.rows.map(row => ({
        id: row.id,
        canvas: typeof row.canvas === "string" ? JSON.parse(row.canvas) : row.canvas,
      }));
    } finally {
      client.release();
    }
    
    // Process each user independently.
    for (const user of users) {
      try {
        await processUserCanvasData(user);
        console.log(`User ${user.id} processed successfully.`);
      } catch (err) {
        console.error(`Error processing user ${user.id}: ${err.message}`);
      }
    }
    return { statusCode: 200, body: "Canvas sync completed." };
  } catch (err) {
    console.error("Global error in Canvas sync:", err);
    return { statusCode: 500, body: "Error in Canvas sync." };
  }
};