'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
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

const S3_RAW_BUCKET_NAME = process.env.S3_RAW_BUCKET;

// ---------- Helper Functions ----------

function attachStableIds(fullRawDataPerCourse) {
  fullRawDataPerCourse.forEach(courseData => {
    const courseIdForSource = courseData.course.id;
    if (courseData.assignments) {
      courseData.assignments = courseData.assignments.map(item => ({
        ...item,
        source_id: `canvas-assignment-${item.id}`,
      }));
    }
    if (courseData.announcements) {
      courseData.announcements = courseData.announcements.map(item => ({
        ...item,
        source_id: item.id 
          ? `canvas-announcement-${item.id}` 
          : `canvas-announcement-${courseIdForSource}-${item.created_at}-${crypto.createHash('md5').update(item.title || 'announcement').update(item.message || '').digest('hex').substring(0, 12)}`,
      }));
    }
    if (courseData.modules) {
      courseData.modules = courseData.modules.map(module => {
        const moduleIdForSource = module.id || 'unknownmodule'; // Use module.id if available
        return {
          ...module,
          items: module.items ? module.items.map(item => ({
            ...item,
            source_id: item.id 
              ? `canvas-moduleitem-${item.id}` 
              : `canvas-moduleitem-${courseIdForSource}-${moduleIdForSource}-${crypto.createHash('md5').update(item.title || 'moduleitem').update(item.type || '').digest('hex').substring(0, 12)}`,
          })) : [],
        };
      });
    }
  });
  return fullRawDataPerCourse;
}

// ---------- Pruning Functions for Individual S3 Storage ----------

function pruneCourseForStorage(course) {
    // This assumes course is already pruned during fetch, just return it
    // If further pruning specifically for storage is needed, add it here.
    return course;
}

function pruneAnnouncementForStorage(ann) {
    // Based on user proposal II
    return {
      id: ann.id,
      source_id: ann.source_id, // Assumes already attached
      title: ann.title,
      message: ann.message, // Keep HTML for now
      html_url: ann.html_url,
      posted_at: ann.posted_at || ann.created_at,
      author: ann.author ? { // Simplified author
        id: ann.author.id,
        display_name: ann.author.display_name,
        // avatar_image_url: ann.author.avatar_image_url // Optional: Remove for smaller size
      } : null,
      read_state: ann.read_state, // User-specific, but maybe useful context
      // Simplify attachments if needed:
      // attachments: ann.attachments ? ann.attachments.map(a => ({ id: a.id, display_name: a.display_name, url: a.url, content_type: a.content_type, size: a.size })) : [],
      // Keep full attachments for now unless size is an issue:
      attachments: ann.attachments
    };
}

function pruneAssignmentForStorage(assign) {
    // Based on user proposal III
    return {
        id: assign.id,
        source_id: assign.source_id, // Assumes already attached
        name: assign.name,
        description: assign.description, // Keep HTML for now
        html_url: assign.html_url,
        due_at: assign.due_at,
        lock_at: assign.lock_at,
        points_possible: assign.points_possible,
        published: assign.published,
        submission_types: assign.submission_types,
        assignment_group_id: assign.assignment_group_id,
        assignment_group_name: assign.assignment_group_name, // Added during fetch
        course_id: assign.course_id,
        submission: assign.submission ? { // Simplified submission info
            workflow_state: assign.submission.workflow_state,
            submitted_at: assign.submission.submitted_at,
            graded_at: assign.submission.graded_at,
            score: assign.submission.score,
            grade: assign.submission.grade,
            attempt: assign.submission.attempt
        } : null,
        // Optionally add simplified overrides here if needed
    };
}

function pruneModuleItemForStorage(item, moduleId) { // Pass module ID for context
    // Based on user proposal IV
    return {
        id: item.id,
        source_id: item.source_id, // Assumes already attached
        title: item.title,
        type: item.type,
        html_url: item.html_url,
        content_id: item.content_id,
        published: item.published,
        // Extract key details from content_details if present
        due_at: item.content_details?.due_at,
        points_possible: item.content_details?.points_possible,
        unlock_at: item.content_details?.unlock_at,
        module_id: moduleId, // Add module_id context
        // Keep full content_details for now unless size is proven issue:
        // content_details: item.content_details // Or simplify further if needed
    };
}


// ---------- S3 Storage Helper for Individual Items ----------
// Now performs a read-compare-write to avoid overwriting identical items
async function storeCanvasItemInS3(userId, courseId, itemType, itemId, newItemData) {
  if (!S3_RAW_BUCKET_NAME) {
    console.error(`[CanvasSync] User ${userId}: S3_RAW_BUCKET env var not set. Cannot store individual item.`);
    return;
  }

  const { GetObjectCommand } = require("@aws-sdk/client-s3"); // Ensure GetObjectCommand is available

  // Use provided itemId (should be source_id or stable ID), ensure it's safe for S3 keys
  // Remove prefixes added by attachStableIds for cleaner filenames if desired
  const safeItemId = String(itemId)
    .replace('canvas-announcement-', '')
    .replace('canvas-assignment-', '')
    .replace('canvas-moduleitem-', '')
    .replace(/[^a-zA-Z0-9-_.]/g, '_');
  const s3Key = `raw_data/canvas/${userId}/courses/${courseId}/${itemType}/${safeItemId}.json`;

  let existingData = null;
  try {
    const command = new GetObjectCommand({ Bucket: S3_RAW_BUCKET_NAME, Key: s3Key });
    const response = await s3.send(command);
    // Helper function to convert stream to string
    const streamToString = (stream) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
    const bodyContents = await streamToString(response.Body);
    existingData = JSON.parse(bodyContents);
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      // Object does not exist, this is fine, we treat it as new.
      existingData = null;
    } else {
      // Log other errors (e.g., permissions)
      console.error(`[CanvasSync] User ${userId}: Error getting existing item ${s3Key} from S3:`, error);
      return; // Skip storing this item on error
    }
  }

  // Compare existing data (if any) with the new data
  const newItemDataString = JSON.stringify(newItemData, null, 2);
  const existingDataString = existingData ? JSON.stringify(existingData, null, 2) : null;

  if (newItemDataString === existingDataString) {
    // Data is the same, no need to write
    console.log(`[CanvasSync] User ${userId}: Skipping unchanged item ${s3Key}`); // Optional: Verbose logging
    return;
  } else {
    // Data is new or different, proceed with PutObject
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_RAW_BUCKET_NAME,
        Key: s3Key,
        Body: newItemDataString, // Use the stringified new data
        ContentType: "application/json",
      }));
      if (!existingData) {
        console.log(`[CanvasSync] User ${userId}: Stored NEW item ${s3Key}`); // Optional
      } else {
        console.log(`[CanvasSync] User ${userId}: Updated CHANGED item ${s3Key}`); // Optional
      }
    } catch (error) {
      console.error(`[CanvasSync] User ${userId}: Error storing NEW/CHANGED item ${s3Key} to S3:`, error);
    }
  }
}


// ---------- Canvas Data Fetching ----------
async function fetchCanvasData(domain, accessToken, userId) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://${domain}/api/v1`;
  const now = new Date().toISOString();

  // TODO - API DELTA SYNC: For enhanced efficiency, this function should be extended to support API-level delta sync.
  // This would involve:
  // 1. Storing `last_successful_sync_timestamp_per_course` or per-item-type in the database for each user.
  // 2. Modifying API calls below to use this timestamp if Canvas API supports relevant filters (e.g., `updated_since`, date ranges).
  //    - Announcements: Already use `start_date`/`end_date`. `start_date` could be `last_successful_sync_timestamp`.
  //    - Assignments, Modules, etc.: Check Canvas API docs for parameters that filter by creation/update date.
  //      If not available, all items of that type might need to be fetched for active courses.
  // 3. After a successful sync for a course/item type, update the corresponding timestamp in the database.
  // Current implementation fetches all active data, which is suitable for ensuring completeness but less efficient for frequent syncs.

  let courses;
  try {
    const res = await axios.get(`${baseUrl}/users/self/courses`, {
      headers,
      params: {
        "state[]": "available",
        enrollment_state: "active",
        "include[]": ["term", "enrollments"],
        per_page: 100,
      },
    });
    courses = res.data.filter(course => {
      // Check 1: Exclude specific enrollment term ID
      if (course.enrollment_term_id === 18) {
        console.log(`[CanvasSync] User ${userId}: Filtering out course ${course.id} ('${course.name}') due to enrollment_term_id 18.`);
        return false;
      }

      // Check 2: Ensure user has a 'StudentEnrollment' role in the course
      const isStudent = course.enrollments && course.enrollments.some(e => e.role === 'StudentEnrollment');
      if (!isStudent) {
        const roles = course.enrollments ? course.enrollments.map(e => e.role).join(', ') : 'none';
        console.log(`[CanvasSync] User ${userId}: Filtering out course ${course.id} ('${course.name}') because user role(s) ('${roles}') do not include 'StudentEnrollment'.`);
        return false;
      }

      // Check 3: Existing date-based filtering logic
      const termStart = course.term?.start_at;
      const termEnd = course.term?.end_at;
      const courseStart = course.start_at;
      const courseEnd = course.end_at;
      if (termStart && termEnd) return termStart <= now && termEnd >= now;
      const started = !courseStart || courseStart <= now;
      const notEnded = !courseEnd || courseEnd >= now;
      return started && notEnded;
    }).map(course => ({ // Store essential course details + calendar URL + user roles
      id: course.id,
      name: course.name,
      course_code: course.course_code,
      term_name: course.term?.name || 'N/A',
      account_id: course.account_id,
      uuid: course.uuid,
      start_at: course.start_at,
      created_at: course.created_at,
      default_view: course.default_view,
      root_account_id: course.root_account_id,
      enrollment_term_id: course.enrollment_term_id,
      end_at: course.end_at,
      course_color: course.course_color,
      time_zone: course.time_zone,
      workflow_state: course.workflow_state,
      calendar: course.calendar?.ics,
      // Extract user roles from enrollments
      user_roles_in_course: course.enrollments ? course.enrollments.map(e => e.role) : [],
    }));
    console.log(`[CanvasSync] User ${userId}: Fetched ${courses.length} active courses for domain ${domain}, including enrollment roles.`);
  } catch (err) {
    console.error(`[CanvasSync] User ${userId}: Error fetching courses for domain ${domain}: ${err.message}`, err.response?.data);
    throw new Error(`Error fetching courses: ${err.message}`);
  }

  const rawDataPerCourse = []; // Temporary structure for full data
  for (const courseDetails of courses) {
    const courseId = courseDetails.id;
    let announcements = [];
    let assignments = [];
    let modulesWithItems = [];
    const assignmentGroupsMap = new Map();

    try {
      // TODO-PAGINATION: Handle pagination for assignment groups if a course could have >100.
      const groupsRes = await axios.get(`${baseUrl}/courses/${courseId}/assignment_groups`, { headers, params: { per_page: 100 } });
      groupsRes.data.forEach(group => assignmentGroupsMap.set(group.id, group.name));
    } catch (err) {
      console.warn(`[CanvasSync] User ${userId}, Course ${courseId}: Error fetching assignment groups: ${err.message}`);
    }

    try {
      // TODO-PAGINATION: Handle pagination for announcements.
      const annRes = await axios.get(`${baseUrl}/announcements`, {
        headers,
        params: {
          "context_codes[]": `course_${courseId}`,
          // start_date: lastSyncTimestampForCourseAnnouncements, // Example for API-level delta
          per_page: 100, 
        },
      });
      announcements = annRes.data;
      console.log(`[CanvasSync] User ${userId}, Course ${courseId}: Fetched ${announcements.length} announcements.`);
    } catch (err) {
      console.warn(`[CanvasSync] User ${userId}, Course ${courseId}: Error fetching announcements: ${err.message}`);
    }

    try {
      // TODO-PAGINATION: Handle pagination for assignments.
      const assignRes = await axios.get(`${baseUrl}/courses/${courseId}/assignments`, {
        headers,
        params: { "include[]": ["submission", "overrides", "score_statistics"], per_page: 100 }, 
      });
      assignments = assignRes.data.map(assignment => ({ 
        ...assignment,
        assignment_group_name: assignmentGroupsMap.get(assignment.assignment_group_id) || 'General',
      }));
      console.log(`[CanvasSync] User ${userId}, Course ${courseId}: Fetched ${assignments.length} assignments.`);
    } catch (err) {
      console.warn(`[CanvasSync] User ${userId}, Course ${courseId}: Error fetching assignments: ${err.message}`);
    }

    try {
      // TODO-PAGINATION: Handle pagination for modules.
      const modulesRes = await axios.get(`${baseUrl}/courses/${courseId}/modules`, {
        headers,
        params: { "include[]": ["items", "content_details"], per_page: 100 }, 
      });
      modulesWithItems = modulesRes.data;
      console.log(`[CanvasSync] User ${userId}, Course ${courseId}: Fetched ${modulesWithItems.length} modules.`);
    } catch (err) {
      console.warn(`[CanvasSync] User ${userId}, Course ${courseId}: Error fetching modules: ${err.message}`);
    }

    // Add all fetched (full) data for this course to the temporary structure
    rawDataPerCourse.push({
      course: courseDetails, // Already pruned course object
      announcements: announcements,
      assignments: assignments, // Includes assignment_group_name
      modules: modulesWithItems,
    });
  }

  // Attach stable IDs to the full data structure (modifies in place)
  const fullDataWithIds = attachStableIds(rawDataPerCourse);

  // Create the minimal aggregated structure for the JSON file (Option 1 Pointers)
  const aggregatedDataForJson = fullDataWithIds.map(courseData => ({
    course: courseData.course, // Use the already pruned course details
    announcements: courseData.announcements.map(ann => ({
        id: ann.id,
        source_id: ann.source_id, // Added by attachStableIds
        title: ann.title,
        html_url: ann.html_url,
        posted_at: ann.posted_at || ann.created_at
    })),
    assignments: courseData.assignments.map(assign => ({
        id: assign.id,
        source_id: assign.source_id, // Added by attachStableIds
        name: assign.name,
        html_url: assign.html_url,
        due_at: assign.due_at,
        points_possible: assign.points_possible, // Useful context
        // Provide minimal submission status from the full data
        submission_workflow_state: assign.submission?.workflow_state
    })),
    modules: courseData.modules.map(mod => ({
        id: mod.id,
        name: mod.name,
        // Map module items minimally
        items: mod.items ? mod.items.map(item => ({
            id: item.id,
            source_id: item.source_id, // Added by attachStableIds
            title: item.title,
            type: item.type,
            html_url: item.html_url,
            // Add minimal content details if useful for overview
            due_at: item.content_details?.due_at,
            points_possible: item.content_details?.points_possible
        })) : []
    }))
  }));

  console.log(`[CanvasSync] User ${userId}: Prepared minimal aggregate JSON and full data structure.`);
  // Return both the minimal structure for JSON and the full structure for individual storage
  return { aggregatedForJson: aggregatedDataForJson, fullData: fullDataWithIds };
}

// ---------- Process User's Canvas Data ----------
async function processUserCanvasData(user) {
  const { id: userId, canvas } = user;
  if (!canvas || !canvas.domain || !canvas.accessToken) {
    console.warn(`[CanvasSync] User ${userId} is missing Canvas credentials. Skipping.`);
    return;
  }

  console.log(`[CanvasSync] User ${userId}: Starting Canvas data sync for domain ${canvas.domain}.`);

  // Fetch returns both minimal aggregate and full data (with source_ids attached)
  const { aggregatedForJson, fullData } = await fetchCanvasData(canvas.domain, canvas.accessToken, userId);

  if (S3_RAW_BUCKET_NAME) {
    // Store the MINIMAL aggregated data
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_RAW_BUCKET_NAME,
        Key: `raw_data/canvas/${userId}/all_course_data_latest.json`,
        Body: JSON.stringify(aggregatedForJson, null, 2), // Store minimal pointer version
        ContentType: "application/json",
      }));
      console.log(`[CanvasSync] User ${userId}: Stored minimal aggregated data index to S3.`);
    } catch (error) {
      console.error(`[CanvasSync] User ${userId}: Error storing minimal aggregated data to S3:`, error);
    }

    // Store individual items (PRUNED) using the fullData structure
    console.log(`[CanvasSync] User ${userId}: Starting storage of PRUNED individual Canvas items...`);
    for (const courseData of fullData) { // Iterate through the full data structure
      const courseId = courseData.course.id;

      // Store pruned course info (already pruned in fetch)
      const prunedCourse = pruneCourseForStorage(courseData.course);
      await storeCanvasItemInS3(userId, courseId, 'details', 'course_info', prunedCourse);

      // Store pruned announcements
      if (courseData.announcements) {
        for (const announcement of courseData.announcements) {
           // Use source_id (which includes 'canvas-announcement-') as the unique key for storage
          const announcementKey = announcement.source_id;
          const prunedAnnouncement = pruneAnnouncementForStorage(announcement);
          await storeCanvasItemInS3(userId, courseId, 'announcements', announcementKey, prunedAnnouncement);
        }
      }

      // Store pruned assignments
      if (courseData.assignments) {
        for (const assignment of courseData.assignments) {
          // Use source_id (which includes 'canvas-assignment-') as the unique key
          const assignmentKey = assignment.source_id;
          const prunedAssignment = pruneAssignmentForStorage(assignment);
          await storeCanvasItemInS3(userId, courseId, 'assignments', assignmentKey, prunedAssignment);
        }
      }

      // Store pruned module items
      if (courseData.modules) {
        for (const module of courseData.modules) {
          const moduleIdForPath = module.id || 'unknown_module';
          // Optionally store pruned module info itself (if needed)
          // const prunedModule = { id: module.id, name: module.name, position: module.position, workflow_state: module.workflow_state, unlock_at: module.unlock_at };
          // await storeCanvasItemInS3(userId, courseId, 'modules', moduleIdForPath, prunedModule);

          if (module.items) {
            for (const item of module.items) {
               // Use source_id (which includes 'canvas-moduleitem-') as the unique key
              const itemKey = item.source_id;
              const prunedItem = pruneModuleItemForStorage(item, module.id); // Pass module.id for context
              await storeCanvasItemInS3(userId, courseId, `modules/${moduleIdForPath}/items`, itemKey, prunedItem);
            }
          }
        }
      }
    }
    console.log(`[CanvasSync] User ${userId}: Finished storing PRUNED individual Canvas items.`);
  } else {
     console.warn(`[CanvasSync] User ${userId}: S3_RAW_BUCKET not configured. Skipping S3 storage.`);
  }
  // TODO-DB-DELTA: After successful sync and storage, update `last_successful_sync_timestamp_per_course` in DB if implementing API-level delta.
}

// ---------- Main Handler ----------
exports.handler = async (event, context) => {
  console.log(`[CanvasSync] Starting Canvas raw data sync at ${new Date().toISOString()}`);
  if (!S3_RAW_BUCKET_NAME) {
    console.error("[CanvasSync] Critical: S3_RAW_BUCKET environment variable is not set. Aborting.");
    return { statusCode: 500, body: "S3_RAW_BUCKET not configured." };
  }

  let dbClient;
  try {
    dbClient = await pool.connect();
    const userQueryRes = await dbClient.query(`
      SELECT id, connected_apps->'canvas' AS canvas
      FROM users
      WHERE connected_apps->'canvas' IS NOT NULL
        AND connected_apps->'canvas'->>'domain' IS NOT NULL
        AND connected_apps->'canvas'->>'accessToken' IS NOT NULL
        AND is_disabled = false
    `);
    const users = userQueryRes.rows.map(row => ({
      id: row.id,
      canvas: typeof row.canvas === "string" ? JSON.parse(row.canvas) : row.canvas,
    }));

    if (users.length === 0) {
      console.log("[CanvasSync] No users found with active and configured Canvas connection.");
      return { statusCode: 200, body: "No Canvas users to sync." };
    }

    console.log(`[CanvasSync] Found ${users.length} user(s) to process for Canvas.`);

    for (const user of users) {
      if (!user.canvas) {
          console.warn(`[CanvasSync] User ${user.id} missing canvas connection details. Skipping.`);
          continue;
      }
      try {
        await processUserCanvasData(user);
        console.log(`[CanvasSync] User ${user.id}: Canvas data sync processed successfully.`);
      } catch (err) {
        console.error(`[CanvasSync] User ${user.id}: Error during Canvas data processing: ${err.message}`, err.stack);
      }
    }

    return { statusCode: 200, body: "Canvas raw data sync completed for all applicable users." };

  } catch (err) {
    console.error("[CanvasSync] Global error in handler:", err.message, err.stack);
    return { statusCode: 500, body: "Error in Canvas raw data sync." };
  } finally {
    if (dbClient) {
      dbClient.release();
    }
  }
};
