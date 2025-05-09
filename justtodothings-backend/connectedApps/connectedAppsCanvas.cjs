"use strict";

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const axios = require("axios");
const crypto = require("crypto");

const s3 = new S3Client({});
const pool = new Pool({
  host: process.env.DB_HOST,     
  port: process.env.DB_PORT || 5432,   
  user: process.env.DB_USER,           
  password: process.env.DB_PASS,     
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: true }
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

// Retrieve previous aggregated data from S3 and compute a delta.
async function computeDelta(newData, bucketName, userId) {
  const key = `raw-data/canvas/${userId}/latest.json`;
  let oldData;
  try {
    const getObjectParams = { Bucket: bucketName, Key: key };
    const s3Object = await s3.send(new GetObjectCommand(getObjectParams));
    // SDK v3 returns a stream, so we need to convert it to a string
    const oldDataString = await s3Object.Body.transformToString("utf-8");
    oldData = JSON.parse(oldDataString);
  } catch (err) {
    if (err.name === "NoSuchKey") { // Note: Error code might be different in v3, use err.name
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
    console.log("Raw courses data from API:", JSON.stringify(res.data)); // Log raw data
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
      course_code: course.course_code
    }));
    console.log(`Fetched ${courses.length} courses.`);
  } catch (err) {
    if (err.response) {
      console.error(`Error fetching courses for domain ${domain}. Status: ${err.response.status}, Response: ${JSON.stringify(err.response.data)}, Message: ${err.message}`);
    } else {
      console.error(`Error fetching courses for domain ${domain}. No response received. Error details: Code: ${err.code}, Errno: ${err.errno}, Syscall: ${err.syscall}, Message: ${err.message}, Stack: ${err.stack}`);
    }
    throw new Error(`Error fetching courses: ${err.message}`);
  }

  // 2. For each course, fetch additional data.
  const aggregatedData = [];
  for (const course of courses) {
    let announcements = [];
    let assignments = [];
    let modules = [];

    // Fetch assignment groups for the course
    const assignmentGroupsMap = new Map();
    try {
      const groupsRes = await axios.get(`${baseUrl}/courses/${course.id}/assignment_groups`, { headers });
      groupsRes.data.forEach(group => {
        assignmentGroupsMap.set(group.id, group.name);
      });
      console.log(`Course ${course.id}: Fetched ${assignmentGroupsMap.size} assignment groups.`);
    } catch (err) {
      console.warn(`Course ${course.id}: Error fetching assignment groups: ${err.message}`);
      // Continue without group names if this fails; assignments will get a default group name.
    }

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
      assignments = assignRes.data.map(assignment => {
        const assignmentDataItem = {
          id: assignment.id,
          name: assignment.name,
          description: assignment.description
            ? assignment.description.replace(/<[^>]+>/g, " ").replace(/\n/g, " ").replace(/\u00A0/g, " ")
            : "",
          due_at: assignment.due_at,
          lock_at: assignment.lock_at,
          points_possible: assignment.points_possible,
          submission: null, // Initialize submission as null
          assignment_group_id: assignment.assignment_group_id,
          assignment_group_name: assignmentGroupsMap.get(assignment.assignment_group_id) || 'General',
        };

        // Populate submission details if submission exists and is graded
        if (
          assignment.submission &&
          assignment.submission.workflow_state === 'graded' &&
          assignment.submission.score !== null && // Ensure score is explicitly not null
          assignment.points_possible !== null && typeof assignment.points_possible === 'number' // Ensure points_possible is valid
        ) {
          assignmentDataItem.submission = {
            grade: assignment.submission.grade, // Often a string like "A" or "10/10"
            score: assignment.submission.score, // Numeric score
            submitted_at: assignment.submission.submitted_at,
            workflow_state: assignment.submission.workflow_state,
          };
        }
        return assignmentDataItem;
      });
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

// Helper function to compute performance summary for a course's assignments
function computePerformanceSummary(assignments) {
  if (!assignments || assignments.length === 0) {
    return [];
  }

  const performanceByGroup = new Map();

  assignments.forEach(assignment => {
    if (assignment.submission && assignment.points_possible > 0) { // Only consider graded items with points
      const groupName = assignment.assignment_group_name || 'General';
      if (!performanceByGroup.has(groupName)) {
        performanceByGroup.set(groupName, {
          groupName: groupName,
          totalScore: 0,
          totalPointsPossible: 0,
          gradedItemsCount: 0,
          items: [], // All assignments in the group
          gradedItemsDetails: [], // Details of graded assignments for this group
        });
      }

      const groupSummary = performanceByGroup.get(groupName);
      groupSummary.items.push({ // Keep track of all assignments in the group
        name: assignment.name,
        due_at: assignment.due_at,
      });
      
      // Accumulate scores only for graded items with valid scores and points
      groupSummary.totalScore += assignment.submission.score;
      groupSummary.totalPointsPossible += assignment.points_possible;
      groupSummary.gradedItemsCount++;
      groupSummary.gradedItemsDetails.push({
        name: assignment.name,
        score: assignment.submission.score,
        points_possible: assignment.points_possible,
        gradePercentage: (assignment.submission.score / assignment.points_possible) * 100,
      });
    } else if (assignment.assignment_group_name) { // Track assignments even if not graded yet for total count per group
        const groupName = assignment.assignment_group_name || 'General';
        if (!performanceByGroup.has(groupName)) {
            performanceByGroup.set(groupName, {
                groupName: groupName,
                totalScore: 0,
                totalPointsPossible: 0,
                gradedItemsCount: 0,
                items: [],
                gradedItemsDetails: [],
            });
        }
        performanceByGroup.get(groupName).items.push({
            name: assignment.name,
            due_at: assignment.due_at,
        });
    }
  });

  const summaryResult = [];
  for (const [groupName, data] of performanceByGroup.entries()) {
    summaryResult.push({
      groupName: groupName,
      avgGrade: data.gradedItemsCount > 0 ? (data.totalScore / data.totalPointsPossible) * 100 : null,
      // count: data.items.length, // Total assignments in this group (graded or not)
      gradedItemsCount: data.gradedItemsCount, // Number of items contributing to avgGrade
      gradedItems: data.gradedItemsDetails, // Actual graded items with their scores
    });
  }
  return summaryResult;
}

async function analyzeWithChatGPT(chatGPTInput) {
  const prompt = buildChatGPTPrompt(chatGPTInput);
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL || "o4-mini",
        messages: [
          {
            role: "system",
            content: "You are an assistant that summarizes Canvas course data into concise to-do items. For each item, return the source_id, description, and due_date provided in the input. Titles will be generated by our system.",
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
          ...(process.env.OPENAI_ORGANIZATION_ID && { "OpenAI-Organization": process.env.OPENAI_ORGANIZATION_ID }),
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

function buildChatGPTPrompt(chatGPTInput) {
  // chatGPTInput is { newItems: deltaData, performanceSummaries: { courseId: { courseName, summary } } }
  const { newItems, performanceSummaries } = chatGPTInput;

  let performanceSummaryText = "";
  if (performanceSummaries) {
    for (const courseId in performanceSummaries) {
      const { courseName, summary } = performanceSummaries[courseId];
      if (summary && summary.length > 0) {
        performanceSummaryText += `Student Performance Summary for ${courseName}:\n`;
        summary.forEach(group => {
          performanceSummaryText += `- ${group.groupName}: `;
          if (group.gradedItemsCount > 0 && group.avgGrade !== null) {
            performanceSummaryText += `${group.avgGrade.toFixed(2)}% average over ${group.gradedItemsCount} graded item(s)`;
            // Heuristic: if group name suggests individual display or few items, list them.
            const individualDisplayKeywords = ['midterm', 'final', 'project', 'exam'];
            const isIndividualDisplayGroup = individualDisplayKeywords.some(keyword => group.groupName.toLowerCase().includes(keyword));
            
            if (group.gradedItemsCount <= 2 || isIndividualDisplayGroup) {
              performanceSummaryText += " (Details: ";
              performanceSummaryText += group.gradedItems.map(item => `${item.name}: ${item.gradePercentage.toFixed(2)}%`).join(', ');
              performanceSummaryText += ")";
            }
            // Add qualitative note based on average grade
            if (group.avgGrade >= 90) performanceSummaryText += " (excellent)";
            else if (group.avgGrade >= 80) performanceSummaryText += " (good)";
            else if (group.avgGrade >= 70) performanceSummaryText += " (fair)";
            else if (group.avgGrade >= 0) performanceSummaryText += " (needs improvement)"; // Handles 0 avgGrade too
            else performanceSummaryText += " (no graded items with points)";


          } else {
            performanceSummaryText += "No graded items with points available for an average.";
          }
          performanceSummaryText += "\n";
        });
        performanceSummaryText += "\n";
      }
    }
  }
  
  // Prepare upcoming items text from newItems (deltaData)
  let upcomingItemsText = "Upcoming Assignments and Other Items:\n";
  let hasUpcomingContent = false;
  newItems.forEach(course => {
    let courseContentAdded = false;
    if (course.assignments && course.assignments.length > 0) {
      if (!courseContentAdded) upcomingItemsText += `For course ${course.course.name}:\n`;
      course.assignments.forEach(assignment => {
        upcomingItemsText += `  - Assignment: ${assignment.name} (due: ${assignment.due_at || 'N/A'}, source_id: ${assignment.source_id})\n`;
      });
      hasUpcomingContent = true;
      courseContentAdded = true;
    }
    if (course.announcements && course.announcements.length > 0) {
      if (!courseContentAdded) upcomingItemsText += `For course ${course.course.name}:\n`;
      course.announcements.forEach(ann => {
        upcomingItemsText += `  - Announcement: ${ann.title} (source_id: ${ann.source_id})\n`;
      });
      hasUpcomingContent = true;
      courseContentAdded = true;
    }
    if (course.modules) {
        course.modules.forEach(module => {
            if (module.items && module.items.length > 0) {
                if (!courseContentAdded) {
                    upcomingItemsText += `For course ${course.course.name} - Module ${module.module_name}:\n`;
                    courseContentAdded = true;
                } else if (!upcomingItemsText.includes(`Module ${module.module_name}`)){
                     upcomingItemsText += `  Module ${module.module_name}:\n`;
                }
                module.items.forEach(item => {
                    upcomingItemsText += `    - Module Item: ${item.title} (type: ${item.type}, due: ${item.due_date || 'N/A'}, source_id: ${item.source_id})\n`;
                });
                hasUpcomingContent = true;
            }
        });
    }
  });

  if (!hasUpcomingContent) {
    upcomingItemsText = "No new upcoming assignments or items.\n";
  }

  // Truncate newItems data to avoid token limits for the raw data part.
  // The detailed upcomingItemsText and performanceSummaryText are already constructed.
  const dataSnippet = JSON.stringify(newItems.map(course => ({
      course: course.course,
      assignments: (course.assignments || []).map(a => ({name: a.name, due_at: a.due_at, source_id: a.source_id, description: (a.description || "").slice(0,100) })), // Keep description brief
      announcements: (course.announcements || []).map(an => ({title: an.title, source_id: an.source_id})),
      modules: (course.modules || []).map(m => ({
          module_name: m.module_name,
          items: (m.items || []).map(i => ({title: i.title, type: i.type, due_date: i.due_date, source_id: i.source_id}))
      }))
  }))).slice(0, 4000); // Reduced slice size as more text is now in prompt

  return `
    ${performanceSummaryText}
    ${upcomingItemsText}
    
    Brief overview of new items (for context, use source_id from detailed list above):
    ${dataSnippet}

    Instructions:
    Based on the student's performance summary and the upcoming items, generate a JSON array of to-do items.
    Each to-do item must have the following keys: "source_id", "description", "due_date".
    - The "source_id" in your output MUST EXACTLY MATCH the one provided in the "Upcoming Assignments and Other Items" list.
    - Prioritize tasks related to assignment types where the student's historical average is lowest.
    - For assignments in areas of weakness, break them into actionable sub-steps in the "description".
    - Include personalized study tips or reminders in the "description" based on past performance if applicable.
    - If an item is not an assignment (e.g. announcement, module item that's not a graded task), create a simple to-do by providing its "source_id", a brief "description" (e.g., "Review [item title]"), and its "due_date" if available.
    - Ensure "due_date" is correctly formatted (YYYY-MM-DDTHH:mm:ssZ or null if not applicable).
    Return only the valid JSON array of to-do objects. Do not include any other text or explanations outside the JSON.
    Note: We will fill in each to-do's title based on assignment metadata in our code.
  `;
}

// ---------- Process users Canvas Data ----------

async function processUserCanvasData(user) {
  const { id: userId, canvas } = user;
  if (!canvas.domain || !canvas.accessToken) {
    throw new Error(`User ${userId} is missing Canvas credentials.`);
  }
  let aggregatedData = await fetchCanvasData(canvas.domain, canvas.accessToken);
  
  // Add performance summaries to aggregatedData
  aggregatedData.forEach(course => {
    if (course.assignments && course.assignments.length > 0) { // Check if assignments exist
      course.performanceSummary = computePerformanceSummary(course.assignments);
    } else {
      course.performanceSummary = []; // Ensure performanceSummary key exists
    }
  });

  aggregatedData = attachStableIds(aggregatedData);
  
  // Compute the delta (new items only) relative to previous sync.
  const deltaData = await computeDelta(aggregatedData, process.env.S3_RAW_BUCKET, userId);
  const now = new Date();

  // Filter deltaData for upcoming assignments (due_at in future)
  // And ensure other items in delta also have source_id if they are to be processed
  deltaData.forEach(course => {
    if (course.assignments) {
      course.assignments = course.assignments.filter(
        asgn => asgn.due_at && new Date(asgn.due_at) > now && asgn.source_id
      );
    }
    if (course.announcements) {
        course.announcements = course.announcements.filter(ann => ann.source_id);
    }
    if (course.modules) {
        course.modules.forEach(module => {
            if (module.items) {
                module.items = module.items.filter(item => item.source_id);
            }
        });
    }
  });
  
  // Always update the latest aggregated data in S3.
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_RAW_BUCKET,
    Key: `raw-data/canvas/${userId}/latest.json`,
    Body: JSON.stringify(aggregatedData, null, 2),
    ContentType: "application/json",
  }));
  
  // If the delta is effectively empty (no new source_ids for relevant items), skip ChatGPT.
  const hasNewItemsForGPT = deltaData.some(course =>
    (course.assignments && course.assignments.length > 0) ||
    (course.announcements && course.announcements.length > 0) ||
    (course.modules && course.modules.some(module => module.items && module.items.length > 0))
  );
  
  if (!hasNewItemsForGPT) {
    console.log(`No new relevant Canvas items for user ${userId} after filtering; skipping ChatGPT analysis.`);
    return;
  }

  // Prepare data for ChatGPT: deltaData (new, upcoming items) and corresponding performance summaries
  const chatGPTInput = {
    newItems: deltaData,
    performanceSummaries: {}
  };

  deltaData.forEach(deltaCourseItem => {
    // Find the original course from aggregatedData to get its full performance summary
    const originalCourseData = aggregatedData.find(
      aggC => aggC.course.id === deltaCourseItem.course.id
    );
    if (originalCourseData && originalCourseData.performanceSummary) {
      chatGPTInput.performanceSummaries[deltaCourseItem.course.id] = {
        courseName: originalCourseData.course.name,
        summary: originalCourseData.performanceSummary // This is the array from computePerformanceSummary
      };
    }
  });
  
  // Analyze the prepared data with ChatGPT to generate to-dos.
  const todosFromGPT = await analyzeWithChatGPT(chatGPTInput);
  
  // Post-process todos to add titles for assignments, announcements, and module items
  const todos = todosFromGPT.map(currentTodo => {
    let title;
    let originalItemDetails = { name: null, type: null, course: null, moduleName: null };

    // Search in aggregatedData for the item matching currentTodo.source_id
    for (const courseData of aggregatedData) {
      let found = false;
      // Check assignments
      if (courseData.assignments) {
        const item = courseData.assignments.find(a => a.source_id === currentTodo.source_id);
        if (item) {
          originalItemDetails = { name: item.name, type: 'assignment', course: courseData.course, moduleName: null };
          found = true;
        }
      }
      if (found) break;

      // Check announcements
      if (courseData.announcements) {
        const item = courseData.announcements.find(ann => ann.source_id === currentTodo.source_id);
        if (item) {
          originalItemDetails = { name: item.title, type: 'announcement', course: courseData.course, moduleName: null };
          found = true;
        }
      }
      if (found) break;

      // Check module items
      if (courseData.modules) {
        for (const module of courseData.modules) {
          if (module.items) {
            const item = module.items.find(mi => mi.source_id === currentTodo.source_id);
            if (item) {
              originalItemDetails = { name: item.title, type: 'moduleItem', course: courseData.course, moduleName: module.module_name };
              found = true;
              break; // Found in module items, break from module loop
            }
          }
        }
      }
      if (found) break; // Found in this course, break from courseData loop
    }

    if (originalItemDetails.course && originalItemDetails.name) {
      const courseName = originalItemDetails.course.name;
      const courseCode = originalItemDetails.course.course_code;
      switch (originalItemDetails.type) {
        case 'assignment':
          title = `${originalItemDetails.name}: ${courseCode} (${courseName})`;
          break;
        case 'announcement':
          title = `Review: "${originalItemDetails.name}" - ${courseCode} (${courseName})`;
          break;
        case 'moduleItem':
          title = `Review: "${originalItemDetails.name}" (Module: ${originalItemDetails.moduleName}) - ${courseCode} (${courseName})`;
          break;
        default:
          console.warn(`Unknown item type or missing details for source_id: ${currentTodo.source_id} while generating title.`);
      }
    } else {
      console.warn(`Could not find original item details for source_id: ${currentTodo.source_id} to generate title.`);
    }

    return {
      ...currentTodo,
      title: title // title will be undefined if not generated, handled by upsertTasks
    };
  });

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