"use strict";

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const axios = require("axios"); // Or Google AI SDK for Gemini

const s3 = new S3Client({});
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: true }
});
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = "gemini-2.5-pro-preview-03-25"; // Force specific model

// Helper to call Gemini API
async function callGeminiForAnalysis(s3ObjectContentString, integrationType, s3Key) {
    let contextSnippet = "";
    let defaultCanvasItemName = null;
    const MAX_DESC_LENGTH = 4000; // Max characters of description to pass to Gemini

    // 1. Extract RELEVANT part of the S3 object content for the prompt
    try {
        const jsonData = JSON.parse(s3ObjectContentString);

        if (integrationType === "gmail") {
            contextSnippet = `Email Subject: ${jsonData.subject}\nFrom: ${jsonData.from}\nSnippet: ${jsonData.snippet}\nBody (first 500 chars): ${(jsonData.bodyText || jsonData.bodyHtml || "").substring(0, 500)}`;
        } else if (integrationType === "github") {
            if (jsonData.type === 'PushEvent' && jsonData.payload?.commits?.length > 0) {
                const commit = jsonData.payload.commits[0];
                contextSnippet = `GitHub Push Event: User ${jsonData.actor?.login} pushed commit. Message: ${commit.message}. Repo: ${jsonData.repo?.name}.`;
            } else if (jsonData.type === 'IssuesEvent' && jsonData.payload?.issue) {
                contextSnippet = `GitHub Issue ${jsonData.payload.action}: "${jsonData.payload.issue.title}" by ${jsonData.payload.issue.user?.login}. Body: ${jsonData.payload.issue.body?.substring(0, 500)}. Repo: ${jsonData.repo?.name}.`;
            } else if (jsonData.type === 'PullRequestEvent' && jsonData.payload?.pull_request) {
                contextSnippet = `GitHub Pull Request ${jsonData.payload.action}: "${jsonData.payload.pull_request.title}" by ${jsonData.payload.pull_request.user?.login}. Body: ${jsonData.payload.pull_request.body?.substring(0, 500)}. Repo: ${jsonData.repo?.name}.`;
            } else {
                contextSnippet = `GitHub Event Type: ${jsonData.type}. Data: ${JSON.stringify(jsonData.payload || jsonData).substring(0,500)}`;
            }
        } else if (integrationType === "slack") {
            contextSnippet = `Slack Message from channel/user ${jsonData.channel || 'unknown'}: User ${jsonData.user || 'unknown_user'} said: "${jsonData.text?.substring(0, 500)}"`;
            if(jsonData.thread_ts && jsonData.ts !== jsonData.thread_ts) {
                contextSnippet += ` (This is a reply in a thread).`;
            }
        } else if (integrationType === "canvas") {
            let fullDescription = "";
            if (jsonData.description) {
                fullDescription = jsonData.description.replace(/<[^>]+>/g, ' ').trim();
            } else if (jsonData.message) { // For announcements
                fullDescription = jsonData.message.replace(/<[^>]+>/g, ' ').trim();
            }

            if (s3Key.includes('/assignments/')) {
                contextSnippet = `Canvas Assignment: "${jsonData.name}". Due: ${jsonData.due_at}. Points: ${jsonData.points_possible}. Full Description: ${fullDescription.substring(0, MAX_DESC_LENGTH)}`;
                if (jsonData.name) defaultCanvasItemName = jsonData.name;
            } else if (s3Key.includes('/announcements/')) {
                contextSnippet = `Canvas Announcement: "${jsonData.title}". Posted: ${jsonData.posted_at}. Full Message: ${fullDescription.substring(0, MAX_DESC_LENGTH)}`;
                if (jsonData.title) defaultCanvasItemName = jsonData.title;
            } else if (s3Key.includes('/quizzes/')) { // Assuming quizzes might be another type
                 contextSnippet = `Canvas Quiz: "${jsonData.title || jsonData.name}". Due: ${jsonData.due_at}. Points: ${jsonData.points_possible}. Full Description: ${fullDescription.substring(0, MAX_DESC_LENGTH)}`;
                 if (jsonData.title) defaultCanvasItemName = jsonData.title;
                 else if (jsonData.name) defaultCanvasItemName = jsonData.name;
            } else {
                 // Generic Canvas item
                 contextSnippet = `Canvas Item. Name: ${jsonData.name || jsonData.title || 'N/A'}. Full Data (partial): ${JSON.stringify(jsonData).substring(0,500)}. Full Description: ${fullDescription.substring(0, MAX_DESC_LENGTH)}`;
                 if (jsonData.name) defaultCanvasItemName = jsonData.name;
                 else if (jsonData.title) defaultCanvasItemName = jsonData.title;
            }
        } else {
            contextSnippet = `Unknown data item: ${s3ObjectContentString.substring(0, 1000)}`;
        }
    } catch (parseError) {
        console.error(`[InitialAnalysis] Error parsing S3 object content for ${s3Key}:`, parseError);
        contextSnippet = `Raw data item (parse failed): ${s3ObjectContentString.substring(0, 1000)}`;
    }


    if (!contextSnippet.trim()) {
        console.warn(`[InitialAnalysis] No context snippet generated for ${s3Key}. Skipping Gemini call.`);
        return { is_actionable: false, error: "No context snippet generated" };
    }

    // Get current date for relative date calculations by Gemini
    const currentDateForPrompt = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // 2. Construct the Prompt
    const prompt = `
        You are an AI assistant tasked with identifying actionable items from various data sources for a to-do list.
        The current date is ${currentDateForPrompt}. Please use this as the reference for any relative date calculations (e.g., if "tomorrow" is mentioned, it means the day after ${currentDateForPrompt}).
        Analyze the following data item from the '${integrationType}' integration:
        --- DATA SNIPPET ---
        ${contextSnippet}
        --- END DATA SNIPPET ---

        Based ONLY on the snippet provided:
        1. Is this item something that requires the user to take a direct action or create a to-do? (e.g., reply to an email, complete an assignment, review a PR, respond to a message asking for something).
        2. If yes, provide:
            - A concise 'item_name' (max 10 words, representing the specific name of the item, e.g., "Chapter 1 Homework", "Midterm Reminder", "Review Project Proposal"). For Canvas items, this should be just the assignment/announcement name itself, without course details.
            - A brief 'summary' (1-2 sentences for the task description).
            - A suggested 'priority' ('low', 'medium', 'important').
            - An extracted 'due_date'. If a date (e.g., "May 15th", "tomorrow") and/or time (e.g., "8 PM", "noon") is mentioned, convert it to a full ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ) using ${currentDateForPrompt} as the reference for "today". If only a date is mentioned, assume end of day. If no specific due date is found, return null.
            - An 'action_type_hint' (e.g., 'email_reply_needed', 'code_review_request', 'assignment_due', 'slack_question_to_answer', 'general_task').

        Respond ONLY with a valid JSON object.
        If actionable, the JSON should be:
        {
            "is_actionable": true,
            "item_name": "Example Item Name",
            "summary": "Example summary of what needs to be done.",
            "priority": "medium",
            "due_date": "2024-09-15T23:59:00Z",
            "action_type_hint": "example_hint"
        }
        If NOT actionable (e.g., informational, an ad, already completed, a simple notification), respond with:
        {
            "is_actionable": false
        }
    `;

    // 3. Call Gemini API
    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    // responseMimeType: "application/json", // If Gemini supports forcing JSON output directly
                    temperature: 0.2,
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        let geminiResponseText = "";
        if (response.data && response.data.candidates && response.data.candidates.length > 0) {
            const candidate = response.data.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0 && candidate.content.parts[0].text) {
                 geminiResponseText = candidate.content.parts[0].text;
            } else if (candidate.finishReason === "SAFETY") {
                console.warn(`[InitialAnalysis] Gemini response for key ${s3Key} was blocked due to safety reasons. Candidate:`, JSON.stringify(candidate));
                return { is_actionable: false, error: "Gemini safety block", details: candidate.safetyRatings };
            }
        }

        if (!geminiResponseText) {
            console.error("[InitialAnalysis] Gemini API returned an empty or unexpected response structure for key:", s3Key, "Response:", JSON.stringify(response.data));
            return { is_actionable: false, error: "Gemini empty response" };
        }

        const cleanedResponseText = geminiResponseText.replace(/^```json\s*|```\s*$/g, '').trim();

        try {
            const analysisResult = JSON.parse(cleanedResponseText);

            // If it's a Canvas item, is actionable, and we have a default name, use that instead of Gemini's.
            if (integrationType === "canvas" && analysisResult.is_actionable === true && defaultCanvasItemName) {
                console.log(`[InitialAnalysis] Overwriting Gemini 'item_name' with fetched Canvas item name: "${defaultCanvasItemName}" for S3 key ${s3Key}`);
                analysisResult.item_name = defaultCanvasItemName;
            }

            return analysisResult;
        } catch (parseError) {
            console.error("[InitialAnalysis] Failed to parse Gemini JSON response for key:", s3Key, "Raw response:", cleanedResponseText, "Parse Error:", parseError);
            return { is_actionable: false, error: "JSON parse error", raw_response: cleanedResponseText };
        }

    } catch (error) {
        console.error("[InitialAnalysis] Error calling Gemini API for key:", s3Key, error.response ? JSON.stringify(error.response.data) : error.message);
        // console.error("Gemini Prompt that failed (first 500 chars):", prompt.substring(0,500));
        return { is_actionable: false, error: "Gemini API call failed" };
    }
}

// Placeholder for Slack teamId/userId mapping
async function findAppUserIdForSlackTeam(teamId) {
    const dbClient = await pool.connect();
    try {
        // Find any user in your app that has this Slack team_id connected
        const res = await dbClient.query(
            "SELECT id FROM users WHERE connected_apps->'slack'->>'team_id' = $1 LIMIT 1",
            [teamId]
        );
        if (res.rows.length > 0) {
            console.log(`[findAppUserIdForSlackTeam] Found app user ${res.rows[0].id} for Slack team ${teamId}`);
            return res.rows[0].id;
        }
        console.warn(`[findAppUserIdForSlackTeam] No app user found for Slack team ${teamId}. Cannot assign task.`);
        return null;
    } catch (error) {
        console.error(`[findAppUserIdForSlackTeam] DB error looking up user for team ${teamId}:`, error);
        return null;
    } finally {
        dbClient.release();
    }
}

exports.handler = async (event) => {
    console.log("[InitialAnalysis] Received event:", JSON.stringify(event, null, 2));

    for (const record of event.Records) {
        const bucketName = record.s3.bucket.name;
        const s3Key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

        console.log(`[InitialAnalysis] Processing S3 object: s3://${bucketName}/${s3Key}`);

        const keyParts = s3Key.split('/');
        if (keyParts.length < 3 || keyParts[0] !== 'raw_data') {
            console.warn(`[InitialAnalysis] Skipping S3 key with unexpected format: ${s3Key}`);
            continue;
        }
        const integrationType = keyParts[1];
        const userIdFromKey = keyParts[2]; // UserID for most, TeamID for Slack

        if (!userIdFromKey || !integrationType) {
            console.warn(`[InitialAnalysis] Could not determine userIdFromKey or integrationType from S3 key: ${s3Key}`);
            continue;
        }

        let actualUserIdForTask = userIdFromKey;
        let s3ObjectContentString;
        let jsonDataForTaskCreation;

        try {
            const getObjectParams = { Bucket: bucketName, Key: s3Key };
            const s3Object = await s3.send(new GetObjectCommand(getObjectParams));
            s3ObjectContentString = await s3Object.Body.transformToString("utf-8");
            if (!s3ObjectContentString) {
                console.warn(`[InitialAnalysis] S3 object ${s3Key} is empty. Skipping.`);
                continue;
            }
            jsonDataForTaskCreation = JSON.parse(s3ObjectContentString);
        } catch (error) {
            console.error(`[InitialAnalysis] Error fetching or parsing S3 object ${s3Key}:`, error);
            continue;
        }
        
        if (integrationType === 'slack') {
            const teamIdFromKey = userIdFromKey; 
            actualUserIdForTask = await findAppUserIdForSlackTeam(teamIdFromKey); 
            if (!actualUserIdForTask) {
                console.warn(`[InitialAnalysis] Slack data for team ${teamIdFromKey}: Could not map to an app user. Skipping task creation for S3 key ${s3Key}.`);
                continue; 
            }
            console.log(`[InitialAnalysis] Slack data for team ${teamIdFromKey}. Will assign task to app user ${actualUserIdForTask}.`);
        }

        // Determine canonicalTaskSourceId
        let canonicalTaskSourceId;
        if (integrationType === "canvas") {
            if (jsonDataForTaskCreation.source_id && jsonDataForTaskCreation.source_id.startsWith('canvas-moduleitem-')) {
                // This is a module item, check if it points to an underlying actionable entity
                if (jsonDataForTaskCreation.type === 'Assignment' && jsonDataForTaskCreation.content_id) {
                    canonicalTaskSourceId = `canvas-assignment-${jsonDataForTaskCreation.content_id}`;
                } else if (jsonDataForTaskCreation.type === 'Quiz' && jsonDataForTaskCreation.content_id) {
                    canonicalTaskSourceId = `canvas-quiz-${jsonDataForTaskCreation.content_id}`;
                } else if (jsonDataForTaskCreation.type === 'Discussion' && jsonDataForTaskCreation.content_id) {
                    canonicalTaskSourceId = `canvas-discussion-${jsonDataForTaskCreation.content_id}`;
                } else {
                    // It's a module item like File, Page, ExternalUrl, or content_id is missing. Use its own source_id.
                    canonicalTaskSourceId = jsonDataForTaskCreation.source_id;
                }
            } else if (jsonDataForTaskCreation.source_id) {
                // It's a direct item (assignment, announcement) from /assignments/ or /announcements/
                // or another Canvas item type that has a source_id.
                canonicalTaskSourceId = jsonDataForTaskCreation.source_id;
            } else {
                console.warn(`[InitialAnalysis] Canvas item from ${s3Key} is missing 'source_id'. Using S3 key as canonicalTaskSourceId as a fallback. This may lead to issues.`);
                canonicalTaskSourceId = s3Key; // Fallback
            }
        } else { // For non-Canvas integrations (Gmail, GitHub, Slack)
            canonicalTaskSourceId = s3Key; // Use S3 key as the source identifier
        }
        console.log(`[InitialAnalysis] Determined canonicalTaskSourceId: "${canonicalTaskSourceId}" for S3 key ${s3Key}`);


        console.log(`[InitialAnalysis] Analyzing ${integrationType} data for user/entity ${actualUserIdForTask} (canonical source ID: ${canonicalTaskSourceId}) from ${s3Key} with Gemini.`);
        const analysisResult = await callGeminiForAnalysis(s3ObjectContentString, integrationType, s3Key);

        console.log(`[InitialAnalysis] Gemini analysis result for ${s3Key}:`, JSON.stringify(analysisResult));

        if (analysisResult && analysisResult.is_actionable === true) {
            if (!analysisResult.item_name || !analysisResult.summary) {
                console.warn(`[InitialAnalysis] Actionable item from ${s3Key} (canonical: ${canonicalTaskSourceId}) missing item_name or summary from Gemini. Skipping. Result:`, analysisResult);
                continue;
            }
            const { item_name, summary, priority, due_date: taskDueDateStringFromGemini, action_type_hint } = analysisResult;
            let finalTaskTitle = item_name; // Default title is the item_name from Gemini/Canvas data
            let courseInfoForLogging = null; // For detailed logging
            let taskDescriptionForDB = summary; // Use Gemini's summary, now based on fuller context for Canvas

            if (integrationType === "canvas") {
                const keyPartsForCanvas = s3Key.split('/'); // e.g. raw_data/canvas/USER_ID/courses/COURSE_ID/...
                const userIdForCanvas = keyPartsForCanvas[2]; 
                const courseIdFromS3Key = keyPartsForCanvas[4]; 

                if (userIdForCanvas && courseIdFromS3Key) {
                    const courseInfoKey = `raw_data/canvas/${userIdForCanvas}/courses/${courseIdFromS3Key}/details/course_info.json`;
                    try {
                        const courseInfoObject = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: courseInfoKey }));
                        const courseInfoString = await courseInfoObject.Body.transformToString("utf-8");
                        const courseInfo = JSON.parse(courseInfoString);
                        courseInfoForLogging = courseInfo; // Store for logging

                        let courseDetailsText = "";
                        if (courseInfo.course_code && courseInfo.name) {
                            courseDetailsText = `${courseInfo.course_code} (${courseInfo.name})`;
                        } else if (courseInfo.course_code) {
                            courseDetailsText = courseInfo.course_code;
                        } else if (courseInfo.name) {
                            courseDetailsText = `(${courseInfo.name})`;
                        }
                        
                        if (courseDetailsText) {
                            finalTaskTitle = `${item_name}: ${courseDetailsText}`;
                        }
                        console.log(`[InitialAnalysis] Canvas task title formatted: "${finalTaskTitle}" using course info from ${courseInfoKey}`);
                    } catch (s3Error) {
                        console.warn(`[InitialAnalysis] Could not fetch/parse course_info.json at ${courseInfoKey} for ${s3Key}. Using base item name "${item_name}". Error: ${s3Error.message}`);
                    }
                } else {
                    console.warn(`[InitialAnalysis] Could not extract userIdForCanvas or courseIdFromS3Key from S3 key ${s3Key} for Canvas title formatting. Base item name: "${item_name}"`);
                }
            }
            
            if (!actualUserIdForTask) {
                 console.warn(`[InitialAnalysis] No actualUserIdForTask identified for ${s3Key} (canonical: ${canonicalTaskSourceId}). Skipping task. Item name: "${item_name}"`);
                 continue;
            }

            let taskPassesDueDateFilter = false;
            let actualDueDateForDB = null;

            if (taskDueDateStringFromGemini) {
                let parsedTaskDueDate;
                try {
                    parsedTaskDueDate = new Date(taskDueDateStringFromGemini);
                    if (isNaN(parsedTaskDueDate.getTime())) {
                        throw new Error("Invalid date value from Gemini");
                    }
                } catch (dateError) {
                    console.warn(`[InitialAnalysis] Invalid due_date format from Gemini for ${s3Key} (canonical: ${canonicalTaskSourceId}): '${taskDueDateStringFromGemini}'. Error: ${dateError.message}`);
                }

                if (parsedTaskDueDate && !isNaN(parsedTaskDueDate.getTime())) {
                    const now = new Date();
                    const tomorrowStart = new Date(now);
                    tomorrowStart.setUTCHours(0, 0, 0, 0);
                    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
                    const fourDaysFromNowStart = new Date(now);
                    fourDaysFromNowStart.setUTCHours(0, 0, 0, 0);
                    fourDaysFromNowStart.setUTCDate(fourDaysFromNowStart.getUTCDate() + 4);

                    if (parsedTaskDueDate >= tomorrowStart && parsedTaskDueDate < fourDaysFromNowStart) {
                        taskPassesDueDateFilter = true;
                        actualDueDateForDB = taskDueDateStringFromGemini; 
                    } else {
                        console.log(`[InitialAnalysis] Task due date ${taskDueDateStringFromGemini} for ${s3Key} (canonical: ${canonicalTaskSourceId}) is outside the 1-3 day window (Range: [${tomorrowStart.toISOString()}, ${fourDaysFromNowStart.toISOString()}) ). Skipping task creation.`);
                    }
                }
            } else {
                 console.log(`[InitialAnalysis] Task from ${s3Key} (canonical: ${canonicalTaskSourceId}) has no due_date provided by Gemini. Skipping task creation based on 1-3 day due date rule.`);
            }

            if (!taskPassesDueDateFilter) { 
                console.log(`[InitialAnalysis] Task from ${s3Key} (canonical: ${canonicalTaskSourceId}) skipped due to due date filter. Due date from Gemini: '${taskDueDateStringFromGemini || 'N/A'}'`);
                continue; 
            }

            const dbClient = await pool.connect();
            try {
                const sourceMetadata = { 
                    action_type_hint, 
                    integration_type: integrationType, 
                    original_s3_key_user_id: userIdFromKey,
                    s3_key_processed: s3Key // Add the S3 key of the object that was processed
                };

                const validPriorities = ['low', 'medium', 'important'];
                const taskPriority = validPriorities.includes(String(priority)?.toLowerCase()) ? String(priority).toLowerCase() : 'medium';
                
                if (integrationType === "canvas") {
                    console.log(`[InitialAnalysis] Preparing to upsert Canvas task. User: ${actualUserIdForTask}, Canonical Source ID: "${canonicalTaskSourceId}"`);
                    console.log(`  Title to be upserted: "${finalTaskTitle}" (from item_name: "${item_name}")`);
                    console.log(`  Course Code: "${courseInfoForLogging?.course_code}", Course Name: "${courseInfoForLogging?.name}"`);
                    console.log(`  Description: "${taskDescriptionForDB.trim()}"`);
                    console.log(`  Priority: ${taskPriority}, DueDate for DB: ${actualDueDateForDB}`);
                    console.log(`  Source Metadata: ${JSON.stringify(sourceMetadata)}`);
                }


                const upsertQuery = `
                    INSERT INTO tasks (user_id, title, description, priority, due_date, source_id, source_metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (user_id, source_id) DO UPDATE
                    SET title = EXCLUDED.title,
                        description = EXCLUDED.description,
                        priority = EXCLUDED.priority,
                        due_date = EXCLUDED.due_date,
                        source_metadata = EXCLUDED.source_metadata,
                        updated_at = now()
                    RETURNING id, (xmax = 0) AS inserted; 
                `;
                
                const values = [
                    actualUserIdForTask,
                    finalTaskTitle.trim(),
                    taskDescriptionForDB.trim(),
                    taskPriority,
                    actualDueDateForDB, 
                    canonicalTaskSourceId, // Use the derived canonical source ID
                    JSON.stringify(sourceMetadata)
                ];
                const res = await dbClient.query(upsertQuery, values);
                const wasInserted = res.rows[0].inserted;
                const actionTaken = wasInserted ? "created" : "updated";
                console.log(`[InitialAnalysis] Successfully ${actionTaken} task ID ${res.rows[0].id} for user ${actualUserIdForTask} from S3 object ${s3Key} (canonical source ID: ${canonicalTaskSourceId}).`);

            } catch (dbError) {
                console.error(`[InitialAnalysis] DB Error ${dbError.message.includes('violates unique constraint "tasks_unique_source_id"') ? 'upserting (unique constraint hit before ON CONFLICT handling or other issue)' : 'upserting'} task for S3 object ${s3Key}, user ${actualUserIdForTask}, canonical source_id ${canonicalTaskSourceId}:`, dbError);
                console.error(`[InitialAnalysis] Failed Task Data: user_id='${actualUserIdForTask}', title='${finalTaskTitle}', description='${taskDescriptionForDB}', priority='${priority}', due_date='${actualDueDateForDB}', canonical_source_id='${canonicalTaskSourceId}', s3Key='${s3Key}', source_metadata='${JSON.stringify({ action_type_hint, integration_type: integrationType, s3_key_processed: s3Key })}'`);
                if (dbError.code === '23503' && dbError.constraint === 'tasks_user_id_fkey') {
                     console.error(`[InitialAnalysis] Foreign key violation: user_id ${actualUserIdForTask} does not exist in users table.`);
                }
            } finally {
                dbClient.release();
            }
        } else {
            console.log(`[InitialAnalysis] Item from ${s3Key} (canonical: ${canonicalTaskSourceId}) deemed not actionable by Gemini or error occurred. Reason: ${analysisResult?.error || 'Not actionable'}`);
        }
    }
    return { statusCode: 200, body: "Processing complete." };
};


