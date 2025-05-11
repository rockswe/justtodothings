'use strict';

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
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

function attachStableIds(aggregatedData) {
  aggregatedData.forEach(courseData => {
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
  return aggregatedData;
}

// ---------- S3 Storage Helper for Individual Items ----------
async function storeCanvasItemInS3(userId, courseId, itemType, itemId, itemData) {
  if (!S3_RAW_BUCKET_NAME) {
    console.error(`[CanvasSync] User ${userId}: S3_RAW_BUCKET env var not set. Cannot store individual item.`);
    return;
  }
  const safeItemId = String(itemId).replace(/[^a-zA-Z0-9-_.]/g, '_'); // Allow dots for versioned IDs if any
  const s3Key = `raw_data/canvas/${userId}/courses/${courseId}/${itemType}/${safeItemId}.json`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_RAW_BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(itemData, null, 2),
      ContentType: "application/json",
    }));
  } catch (error) {
    console.error(`[CanvasSync] User ${userId}: Error storing ${itemType} ${safeItemId} for course ${courseId} in S3:`, error);
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
        "include[]": "term",
        per_page: 100, 
      },
    });
    courses = res.data.filter(course => {
      const termStart = course.term?.start_at;
      const termEnd = course.term?.end_at;
      const courseStart = course.start_at;
      const courseEnd = course.end_at;
      if (termStart && termEnd) return termStart <= now && termEnd >= now;
      const started = !courseStart || courseStart <= now;
      const notEnded = !courseEnd || courseEnd >= now;
      return started && notEnded;
    }).map(course => ({ // Store comprehensive course details
      id: course.id,
      name: course.name,
      course_code: course.course_code,
      term_name: course.term?.name || 'N/A',
      account_id: course.account_id,
      uuid: course.uuid,
      start_at: course.start_at,
      grading_standard_id: course.grading_standard_id,
      is_public: course.is_public,
      created_at: course.created_at,
      default_view: course.default_view,
      root_account_id: course.root_account_id,
      enrollment_term_id: course.enrollment_term_id,
      license: course.license,
      grade_passback_setting: course.grade_passback_setting,
      end_at: course.end_at,
      public_syllabus: course.public_syllabus,
      public_syllabus_to_auth: course.public_syllabus_to_auth,
      storage_quota_mb: course.storage_quota_mb,
      is_public_to_auth_users: course.is_public_to_auth_users,
      homeroom_course: course.homeroom_course,
      course_color: course.course_color,
      friendly_name: course.friendly_name,
      apply_assignment_group_weights: course.apply_assignment_group_weights,
      calendar: course.calendar?.ics,
      time_zone: course.time_zone,
      blueprint: course.blueprint,
      template: course.template,
      // enrollments: course.enrollments, // Consider if all enrollment data is needed; can be large.
      hide_final_grades: course.hide_final_grades,
      workflow_state: course.workflow_state,
      restrict_enrollments_to_course_dates: course.restrict_enrollments_to_course_dates,
      overridden_course_visibility: course.overridden_course_visibility
    }));
    console.log(`[CanvasSync] User ${userId}: Fetched ${courses.length} active courses for domain ${domain}.`);
  } catch (err) {
    console.error(`[CanvasSync] User ${userId}: Error fetching courses for domain ${domain}: ${err.message}`, err.response?.data);
    throw new Error(`Error fetching courses: ${err.message}`);
  }

  const aggregatedData = [];
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

    aggregatedData.push({
      course: courseDetails,
      announcements,
      assignments,
      modules: modulesWithItems,
    });
  }
  return aggregatedData;
}

// ---------- Process User's Canvas Data ----------
async function processUserCanvasData(user) {
  const { id: userId, canvas } = user;
  if (!canvas || !canvas.domain || !canvas.accessToken) {
    console.warn(`[CanvasSync] User ${userId} is missing Canvas credentials. Skipping.`);
    return;
  }

  console.log(`[CanvasSync] User ${userId}: Starting Canvas data sync for domain ${canvas.domain}.`);
  let aggregatedData = await fetchCanvasData(canvas.domain, canvas.accessToken, userId);
  aggregatedData = attachStableIds(aggregatedData); 

  if (S3_RAW_BUCKET_NAME) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_RAW_BUCKET_NAME,
        Key: `raw_data/canvas/${userId}/all_course_data_latest.json`,
        Body: JSON.stringify(aggregatedData, null, 2),
        ContentType: "application/json",
      }));
      console.log(`[CanvasSync] User ${userId}: Stored aggregated data to S3.`);
    } catch (error) {
      console.error(`[CanvasSync] User ${userId}: Error storing aggregated data to S3:`, error);
    }

    for (const courseData of aggregatedData) {
      const courseId = courseData.course.id;
      await storeCanvasItemInS3(userId, courseId, 'details', 'course_info', courseData.course);
      if (courseData.assignments) {
        for (const assignment of courseData.assignments) {
          await storeCanvasItemInS3(userId, courseId, 'assignments', assignment.id, assignment);
        }
      }
      if (courseData.announcements) {
        for (const announcement of courseData.announcements) {
          await storeCanvasItemInS3(userId, courseId, 'announcements', announcement.source_id.replace('canvas-announcement-',''), announcement);
        }
      }
      if (courseData.modules) {
        for (const module of courseData.modules) {
          const moduleIdForPath = module.id || 'unknown_module';
          if (module.items) {
            for (const item of module.items) {
              await storeCanvasItemInS3(userId, courseId, `modules/${moduleIdForPath}/items`, item.source_id.replace('canvas-moduleitem-',''), item);
            }
          }
        }
      }
    }
    console.log(`[CanvasSync] User ${userId}: Finished storing individual Canvas items.`);
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
