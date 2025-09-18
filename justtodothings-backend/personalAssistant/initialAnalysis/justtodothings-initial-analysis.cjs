"use strict";

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const axios = require("axios");
// Removed unused Lambda invocation for draft email generation

const s3 = new S3Client({});
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: true }
});
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL_NAME = process.env.OPENAI_MODEL_NAME || "gpt-4o-mini"; // Default to 4o-mini
// Removed DRAFT_EMAIL_LAMBDA_FUNCTION_NAME; draft/send features deprecated

// Helper to extract email address from a header string
function extractEmailAddress(emailHeaderValue) {
    if (!emailHeaderValue) return null;
    // Matches an email address enclosed in < >
    const match = emailHeaderValue.match(/<([^>]+)>/);
    // If found, return the captured group (the email), otherwise return the trimmed original value (might be just an email)
    return match ? match[1] : emailHeaderValue.trim();
}

// Quick subject-only actionability check for Gmail to reduce token usage
// Returns { is_actionable: boolean }
async function quickGmailSubjectCheck(subject, fromHeader, userPrimaryEmailForContext = null) {
    if (!subject || !subject.trim()) {
        return { is_actionable: false, reason: "empty_subject" };
    }

    const currentDateForPrompt = new Date().toISOString().split('T')[0];

    const minimalContext = userPrimaryEmailForContext
        ? `The email is addressed to ${userPrimaryEmailForContext}.`
        : '';

    const prompt = `
        You are a conservative filter that decides if an email SUBJECT alone clearly implies the recipient must take an action or respond.
        Today is ${currentDateForPrompt}.
        ${minimalContext}
        From: ${fromHeader || 'unknown'}
        Subject: ${subject}

        Rules:
        - Say actionable only if the subject obviously asks for a response, approval, review, scheduling, confirmation, RSVP, signature, decision, or contains strong cues like "action required", "please review", "need your input", a question directed at the recipient, or a clear task.
        - If ambiguous, promotional, generic  updates, newsletters, or informational only, return not actionable.
        - Respond ONLY with JSON: { "is_actionable": true|false }.
    `;

    try {
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: OPENAI_MODEL_NAME,
                messages: [
                    { role: "user", content: prompt }
                ],
                temperature: 0
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${OPENAI_API_KEY}`
                }
            }
        );

        const openaiResponseText = response?.data?.choices?.[0]?.message?.content || "";

        const cleaned = (openaiResponseText || '').replace(/^```json\s*|```\s*$/g, '').trim();
        try {
            const parsed = JSON.parse(cleaned);
            return { is_actionable: parsed.is_actionable === true };
        } catch (_) {
            return { is_actionable: false, reason: "parse_error" };
        }
    } catch (err) {
        console.warn(`[InitialAnalysis] quickGmailSubjectCheck error: ${err.message}`);
        return { is_actionable: false, reason: "api_error" };
    }
}

// Helper to call OpenAI API for analysis
async function callOpenAIForAnalysis(s3ObjectContentString, integrationType, s3Key, userPrimaryEmailForContext = null) {
    let contextSnippet = "";
    let defaultCanvasItemName = null;
    const MAX_DESC_LENGTH = 4000; // Max characters of description to pass to OpenAI

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
        console.warn(`[InitialAnalysis] No context snippet generated for ${s3Key}. Skipping OpenAI call.`);
        return { is_actionable: false, error: "No context snippet generated" };
    }

    // Get current date for relative date calculations by OpenAI
    const currentDateForPrompt = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    let userContextIntro = "";
    if (integrationType === "gmail" && userPrimaryEmailForContext) {
        userContextIntro = `
        This email is being analyzed for the user whose email address is '${userPrimaryEmailForContext}'. Let's call this user "User Prime".
        The "From" field in the Data Snippet indicates the sender of the email.
        Your goal is to identify if "User Prime" needs to take an action based on this email.
        If the email is from someone else TO "User Prime", the task should be about what "User Prime" needs to do in relation to that sender or the email's content.
        For example, if 'sender@example.com' asks 'User Prime' to 'review document A', the item_name should be something like 'Review document A from sender@example.com' or 'Follow up with sender@example.com about document A'.
        Avoid creating tasks that imply "User Prime" is asking themselves to do something unless the context is explicitly a self-note or reminder sent to oneself (e.g. an email from 'User Prime' to 'User Prime').
        `;
    }

    // 2. Construct the Prompt
    const prompt = `
        You are an AI assistant tasked with identifying actionable items from various data sources for a to-do list.
        The current date is ${currentDateForPrompt}. Please use this as the reference for any relative date calculations (e.g., if "tomorrow" is mentioned, it means the day after ${currentDateForPrompt}).
        ${userContextIntro}
        Analyze the following data item from the '${integrationType}' integration:
        --- DATA SNIPPET ---
        ${contextSnippet}
        --- END DATA SNIPPET ---

        Based ONLY on the snippet provided:
        1. Is this item something that requires the user ("User Prime" if defined above, otherwise the recipient of the data item) to take a direct action or create a to-do? (e.g., reply to an email, complete an assignment, review a PR, respond to a message asking for something).
        2. If yes, provide:
            - A concise 'item_name' (max 10 words, representing the specific name of the item, e.g., "Chapter 1 Homework", "Midterm Reminder", "Review Project Proposal"). For Canvas items, this should be just the assignment/announcement name itself, without course details.
            - A brief 'summary' (1-2 sentences for the task description). The summary should focus on the core action to be taken or the main information from the item. Avoid including phrases like "This email is from..." or mentioning the sender directly in the summary.
            - A suggested 'priority' ('low', 'medium', 'important').
            - An extracted 'due_date'. If a date (e.g., "May 15th", "tomorrow") and/or time (e.g., "8 PM", "noon") is mentioned, convert it to a full ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ) using ${currentDateForPrompt} as the reference for "today". If only a date is mentioned, assume end of day. If no specific due date is found, return null.
            - An 'action_type_hint'. If the data item is an email that seems to ask a question of the user, or implies a response is expected (not just a notification or FYI), use 'email_reply_needed'. Other examples: 'code_review_request', 'assignment_due', 'slack_question_to_answer', 'general_task' for informational items or items not fitting other categories.

        Respond ONLY with a valid JSON object.
        If actionable, the JSON should be:
        {
            "is_actionable": true,
            "item_name": "Example: Follow up with sender@example.com about Report",
            "summary": "Example summary of what needs to be done.",
            "priority": "medium",
            "due_date": "2024-09-15T23:59:00Z",
            "action_type_hint": "example_hint"
        }
        If NOT actionable (e.g., informational, an ad, already completed, a simple notification, or an email sent BY "User Prime" to others that is not a self-reminder), respond with:
        {
            "is_actionable": false
        }
    `;

    // 3. Call OpenAI API
    try {
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: OPENAI_MODEL_NAME,
                messages: [
                    { role: "user", content: prompt }
                ],
                temperature: 0.2
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${OPENAI_API_KEY}`
                }
            }
        );

        const openaiResponseText = response?.data?.choices?.[0]?.message?.content || "";

        if (!openaiResponseText) {
            console.error("[InitialAnalysis] OpenAI API returned an empty or unexpected response structure for key:", s3Key, "Response:", JSON.stringify(response.data));
            return { is_actionable: false, error: "OpenAI empty response" };
        }

        const cleanedResponseText = openaiResponseText.replace(/^```json\s*|```\s*$/g, '').trim();

        try {
            const analysisResult = JSON.parse(cleanedResponseText);

            // If it's a Canvas item, is actionable, and we have a default name, use that instead of the model's suggestion.
            if (integrationType === "canvas" && analysisResult.is_actionable === true && defaultCanvasItemName) {
                console.log(`[InitialAnalysis] Overwriting 'item_name' with fetched Canvas item name: "${defaultCanvasItemName}" for S3 key ${s3Key}`);
                analysisResult.item_name = defaultCanvasItemName;
            }

            return analysisResult;
        } catch (parseError) {
            console.error("[InitialAnalysis] Failed to parse JSON response from OpenAI for key:", s3Key, "Raw response:", cleanedResponseText, "Parse Error:", parseError);
            return { is_actionable: false, error: "JSON parse error", raw_response: cleanedResponseText };
        }

    } catch (error) {
        console.error("[InitialAnalysis] Error calling OpenAI API for key:", s3Key, error.response ? JSON.stringify(error.response.data) : error.message);
        return { is_actionable: false, error: "OpenAI API call failed" };
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

        // If it's a Gmail item, check if it was sent by the user themselves
        if (integrationType === 'gmail' && actualUserIdForTask) {
            const senderHeader = jsonDataForTaskCreation.from; // e.g., "John Doe <john.doe@example.com>" or "john.doe@example.com"
            const senderEmail = extractEmailAddress(senderHeader);

            if (senderEmail) {
                let dbClientForUserEmailCheck; // Declare client variable outside try
                try {
                    dbClientForUserEmailCheck = await pool.connect();
                    const userGmailQuery = await dbClientForUserEmailCheck.query(
                        "SELECT connected_apps->'gmail'->>'email' AS gmail_address FROM users WHERE id = $1",
                        [actualUserIdForTask]
                    );
                    if (userGmailQuery.rows.length > 0 && userGmailQuery.rows[0].gmail_address) {
                        const userConnectedGmailAddress = userGmailQuery.rows[0].gmail_address;
                        if (senderEmail.toLowerCase() === userConnectedGmailAddress.toLowerCase()) {
                            console.log(`[InitialAnalysis] Skipping email sent by the user themselves (user ID: ${actualUserIdForTask}, sender: ${senderEmail}) for S3 key ${s3Key}.`);
                            continue; // Skip to the next S3 record
                        }
                    } else {
                        console.warn(`[InitialAnalysis] Could not retrieve connected Gmail address for user ${actualUserIdForTask} to check if email is outgoing. Proceeding with analysis for ${s3Key}.`);
                    }
                } catch (userEmailError) {
                    console.error(`[InitialAnalysis] DB error fetching user's Gmail address for user ${actualUserIdForTask} (S3 key ${s3Key}):`, userEmailError.message);
                    // Fallback: Proceed with analysis if we can't confirm it's an outgoing email
                } finally {
                    if (dbClientForUserEmailCheck) {
                        dbClientForUserEmailCheck.release();
                    }
                }
            } else {
                console.warn(`[InitialAnalysis] Could not extract sender email from 'from' header: "${senderHeader}" for S3 key ${s3Key}. Proceeding with analysis.`);
            }
        }

        // Fetch user's primary Gmail address for context if it's a Gmail item
        let userAppGmailAddressForContext = null;
        if (integrationType === 'gmail' && actualUserIdForTask) {
            let dbClientUserEmail; // Declare client variable outside try
            try {
                dbClientUserEmail = await pool.connect();
                const userRes = await dbClientUserEmail.query(
                    "SELECT connected_apps->'gmail'->>'email' as gmail_address FROM users WHERE id = $1",
                    [actualUserIdForTask]
                );
                if (userRes.rows.length > 0 && userRes.rows[0].gmail_address) {
                    userAppGmailAddressForContext = userRes.rows[0].gmail_address;
                    console.log(`[InitialAnalysis] Identified user's Gmail address as ${userAppGmailAddressForContext} for task analysis context for S3 key ${s3Key}.`);
                } else {
                    console.warn(`[InitialAnalysis] Could not fetch user's connected Gmail address for user ID ${actualUserIdForTask} (S3 key ${s3Key}). Prompt context might be less specific.`);
                }
            } catch (err) {
                console.error(`[InitialAnalysis] DB error fetching user's Gmail address for ${actualUserIdForTask} (S3 key ${s3Key}): ${err.message}`);
            } finally {
                if (dbClientUserEmail) {
                    dbClientUserEmail.release();
                }
            }
        }

        // Gmail subject-only quick actionability check to reduce token usage
        if (integrationType === 'gmail') {
            const subjectForQuickCheck = jsonDataForTaskCreation?.subject;
            if (subjectForQuickCheck && subjectForQuickCheck.trim()) {
                try {
                    const quickCheck = await quickGmailSubjectCheck(
                        subjectForQuickCheck,
                        jsonDataForTaskCreation?.from,
                        userAppGmailAddressForContext
                    );
                    if (quickCheck && quickCheck.is_actionable === false) {
                        console.log(`[InitialAnalysis] Gmail subject-only quick check deemed NOT actionable for ${s3Key}. Skipping full analysis.`);
                        continue; // Skip to next record to avoid full prompt cost
                    }
                } catch (quickErr) {
                    console.warn(`[InitialAnalysis] quickGmailSubjectCheck failed for ${s3Key}: ${quickErr.message}. Proceeding with full analysis.`);
                }
            } // If no subject or empty, fall through to full analysis which will include body
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


        console.log(`[InitialAnalysis] Analyzing ${integrationType} data for user/entity ${actualUserIdForTask} (canonical source ID: ${canonicalTaskSourceId}) from ${s3Key} with OpenAI (${OPENAI_MODEL_NAME}).`);
        const analysisResult = await callOpenAIForAnalysis(s3ObjectContentString, integrationType, s3Key, userAppGmailAddressForContext);

        console.log(`[InitialAnalysis] OpenAI analysis result for ${s3Key}:`, JSON.stringify(analysisResult));

        if (analysisResult && analysisResult.is_actionable === true) {
            if (!analysisResult.item_name || !analysisResult.summary) {
                console.warn(`[InitialAnalysis] Actionable item from ${s3Key} (canonical: ${canonicalTaskSourceId}) missing item_name or summary. Skipping. Result:`, analysisResult);
                continue;
            }
            const { item_name, summary, priority, due_date: taskDueDateStringFromAI, action_type_hint } = analysisResult;
            let finalTaskTitle = item_name; // Default title is the item_name from OpenAI/Canvas data
            let courseInfoForLogging = null; // For detailed logging
            let taskDescriptionForDB = summary; // Use model's summary, now based on fuller context for Canvas

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

            if (taskDueDateStringFromAI) {
                let parsedTaskDueDate;
                try {
                    parsedTaskDueDate = new Date(taskDueDateStringFromAI);
                    if (isNaN(parsedTaskDueDate.getTime())) {
                        throw new Error("Invalid date value from model");
                    }
                } catch (dateError) {
                    console.warn(`[InitialAnalysis] Invalid due_date format from model for ${s3Key} (canonical: ${canonicalTaskSourceId}): '${taskDueDateStringFromAI}'. Error: ${dateError.message}`);
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
                        actualDueDateForDB = taskDueDateStringFromAI; 
                    } else {
                        console.log(`[InitialAnalysis] Task due date ${taskDueDateStringFromAI} for ${s3Key} (canonical: ${canonicalTaskSourceId}) is outside the 1-3 day window (Range: [${tomorrowStart.toISOString()}, ${fourDaysFromNowStart.toISOString()}) ). Skipping task creation.`);
                    }
                }
            } else {
                 console.log(`[InitialAnalysis] Task from ${s3Key} (canonical: ${canonicalTaskSourceId}) has no due_date provided by model. Skipping task creation based on 1-3 day due date rule.`);
            }

            if (!taskPassesDueDateFilter) { 
                console.log(`[InitialAnalysis] Task from ${s3Key} (canonical: ${canonicalTaskSourceId}) skipped due to due date filter. Due date from model: '${taskDueDateStringFromAI || 'N/A'}'`);
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

                // If it's a Gmail item and we have the sender's email, add it to metadata
                if (integrationType === 'gmail' && jsonDataForTaskCreation?.from) {
                    const senderHeaderForMeta = jsonDataForTaskCreation.from;
                    const extractedSenderEmailForMeta = extractEmailAddress(senderHeaderForMeta);
                    if (extractedSenderEmailForMeta) {
                        sourceMetadata.sender_email = extractedSenderEmailForMeta;
                    }
                }

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

                // Add this new log statement to inspect sourceMetadata before DB operation
                console.log("[InitialAnalysis] Source metadata being prepared for DB:", JSON.stringify(sourceMetadata));

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
                const taskId = res.rows[0].id;
                console.log(`[InitialAnalysis] Successfully ${actionTaken} task ID ${taskId} for user ${actualUserIdForTask} from S3 object ${s3Key} (canonical source ID: ${canonicalTaskSourceId}).`);

                // Draft and send email automation deprecated; no further action triggered here

            } catch (dbError) {
                console.error(`[InitialAnalysis] DB Error ${dbError.message.includes('violates unique constraint "tasks_unique_source_id"') ? 'upserting (unique constraint hit before ON CONFLICT handling or other issue)' : 'upserting'} task for S3 object ${s3Key}, user ${actualUserIdForTask}, canonical source_id ${canonicalTaskSourceId}:`, dbError);
                if (dbError.code === '23503' && dbError.constraint === 'tasks_user_id_fkey') {
                     console.error(`[InitialAnalysis] Foreign key violation: user_id ${actualUserIdForTask} does not exist in users table.`);
                }
            } finally {
                if (dbClient) { // Ensure dbClient was successfully acquired before trying to release
                    dbClient.release();
                }
            }
        } else {
            console.log(`[InitialAnalysis] Item from ${s3Key} (canonical: ${canonicalTaskSourceId}) deemed not actionable by OpenAI or error occurred. Reason: ${analysisResult?.error || 'Not actionable'}`);
        }
    } // end for loop over records
    return { statusCode: 200, body: "Processing complete." };
};