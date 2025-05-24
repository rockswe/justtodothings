"use strict";

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const axios = require("axios");
const { google } = require("googleapis");

// Environment Variables
const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT || 5432;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;

const S3_RAW_BUCKET_NAME = process.env.S3_RAW_BUCKET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = "gemini-2.5-pro-exp-03-25"; 

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

// AWS Clients and DB Pool
const s3 = new S3Client({});
const pool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    ssl: { rejectUnauthorized: true }
});

function transformRawEmail(userId, message) {
    if (!message || !message.payload) {
        console.warn(`[transformRawEmail] Message or message.payload is undefined for user ${userId}, messageId: ${message?.id}`);
        return {
            id: message?.id || null,
            threadId: message?.threadId || null,
            labelIds: message?.labelIds || [],
            snippet: message?.snippet || "",
            historyId: message?.historyId || null,
            internalDate: message?.internalDate || null,
            payload: null, // Indicate payload was missing
            sizeEstimate: message?.sizeEstimate || 0,
            raw: message?.raw || null,
            from: "",
            to: [],
            cc: [],
            bcc: [],
            replyTo: "",
            subject: "",
            bodyText: "",
            bodyHtml: "",
            attachments: [],
            inReplyTo: null,
            references: null,
            messageIdHeader: null,
            dateHeader: null,
        };
    }

    const { id, threadId, labelIds, snippet, historyId, internalDate, payload, sizeEstimate, raw } = message;
    let from = "";
    let to = [];
    let cc = [];
    let bcc = [];
    let replyTo = "";
    let subject = "";
    let bodyText = "";
    let bodyHtml = "";
    let attachments = [];
    let inReplyTo = null;
    let references = null;
    let messageIdHeader = null;
    let dateHeader = null;

    if (payload.headers) {
        payload.headers.forEach(header => {
            if (header.name.toLowerCase() === "from") from = header.value;
            if (header.name.toLowerCase() === "to") to = header.value.split(',').map(s => s.trim()).filter(Boolean);
            if (header.name.toLowerCase() === "cc") cc = header.value.split(',').map(s => s.trim()).filter(Boolean);
            if (header.name.toLowerCase() === "bcc") bcc = header.value.split(',').map(s => s.trim()).filter(Boolean);
            if (header.name.toLowerCase() === "reply-to") replyTo = header.value;
            if (header.name.toLowerCase() === "subject") subject = header.value;
            if (header.name.toLowerCase() === "in-reply-to") inReplyTo = header.value;
            if (header.name.toLowerCase() === "references") references = header.value;
            if (header.name.toLowerCase() === "message-id") messageIdHeader = header.value;
            if (header.name.toLowerCase() === "date") dateHeader = header.value;
        });
    }

    function getPartContent(part) {
        if (part.body && part.body.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        return "";
    }

    function findParts(parts) {
        parts.forEach(part => {
            if (part.mimeType === "text/plain" && !bodyText) { // Prefer first plain text part
                bodyText += getPartContent(part);
            } else if (part.mimeType === "text/html" && !bodyHtml) { // Prefer first html part
                bodyHtml += getPartContent(part);
            } else if (part.filename && part.body && part.body.attachmentId) {
                attachments.push({
                    filename: part.filename,
                    mimeType: part.mimeType,
                    size: part.body.size,
                    attachmentId: part.body.attachmentId
                });
            }
            if (part.parts) {
                findParts(part.parts);
            }
        });
    }

    if (payload.parts) {
        findParts(payload.parts);
    } else if (payload.body && payload.body.data) { // Single part message
        if (payload.mimeType === "text/plain") {
            bodyText = getPartContent(payload);
        } else if (payload.mimeType === "text/html") {
            bodyHtml = getPartContent(payload);
        }
    }
    
    // If only HTML is present, try to create a rudimentary text version
    if (bodyHtml && !bodyText) {
        bodyText = bodyHtml.replace(/<style[^>]*>.*<\/style>/gs, '') // Remove style blocks
                           .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
                           .replace(/\s+/g, ' ')    // Replace multiple spaces with single
                           .trim();
    }


    return {
        id, threadId, labelIds, snippet, historyId, internalDate: internalDate ? new Date(parseInt(internalDate)).toISOString() : null,
        payload: { headers: payload.headers, mimeType: payload.mimeType, filename: payload.filename }, // Simplified payload
        sizeEstimate, raw, // raw can be very large, consider omitting if not needed downstream
        from, to, cc, bcc, replyTo, subject, bodyText, bodyHtml, attachments,
        inReplyTo, references, messageIdHeader, dateHeader,
        userId // Add userId for context if needed later
    };
}

async function getS3Object(bucket, key) {
    try {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3.send(command);
        const str = await response.Body.transformToString("utf-8");
        return JSON.parse(str);
    } catch (error) {
        console.error(`[DraftEmailLambda] Error fetching S3 object s3://${bucket}/${key}:`, error);
        throw error;
    }
}

async function getTaskDetails(dbClient, taskId) {
    const query = "SELECT user_id, source_id FROM tasks WHERE id = $1"; // Removed 'data'
    const { rows } = await dbClient.query(query, [taskId]);
    if (rows.length === 0) {
        throw new Error(`Task with ID ${taskId} not found.`);
    }
    return rows[0];
}

async function getUserDetails(dbClient, userId) {
    const query = "SELECT email, connected_apps->'gmail' AS gmail_creds FROM users WHERE id = $1"; // Removed 'name'
    const { rows } = await dbClient.query(query, [userId]);
    if (rows.length === 0) {
        throw new Error(`User with ID ${userId} not found.`);
    }
    if (!rows[0].gmail_creds || !rows[0].gmail_creds.accessToken) {
        throw new Error(`Gmail credentials (accessToken) not found for user ID ${userId}.`);
    }
    // User's primary email from users.email might be different from connected Gmail account's primary email.
    // The 'email' field in connected_apps.gmail usually stores the specific Gmail address that was connected.
    // For sending 'from:me', this is fine. For identifying user's email in From headers of *their own* sent items,
    // it's better to use the email from users.connected_apps->'gmail'->'email' if available and accurate.
    // For now, we assume 'me' in Gmail API queries correctly refers to the authenticated user.
    // Since 'name' is removed from query, rows[0].name will be undefined. Defaulting to 'User' here, or rely on later specific default like 'Alex Lee'.
    return { 
        name: 'User', // Defaulting directly as rows[0].name is no longer fetched
        email: rows[0].email, // User's primary email in our system
        gmailSpecificEmail: rows[0].gmail_creds.email, // Email associated with this specific Gmail connection
        credentials: rows[0].gmail_creds 
    };
}

function extractEmailAddress(emailHeaderValue) {
    if (!emailHeaderValue) return null;
    const match = emailHeaderValue.match(/<([^>]+)>/);
    return match ? match[1] : emailHeaderValue.trim();
}

async function callGeminiWithRetry(axiosConfig, retries = 3, delay = 2000) { // Increased initial delay
    try {
        return await axios(axiosConfig);
    } catch (error) {
        if (error.response && error.response.status === 429 && retries > 0) {
            console.warn(`[DraftEmailLambda] Gemini API rate limit hit (status 429). Retrying in ${delay / 1000}s... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(axiosConfig, retries - 1, delay * 2); // Exponential backoff
        }
        // Also retry on 500, 503, 504 from Gemini as these are often transient server issues
        if (error.response && [500, 503, 504].includes(error.response.status) && retries > 0) {
            console.warn(`[DraftEmailLambda] Gemini API server error (status ${error.response.status}). Retrying in ${delay / 1000}s... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(axiosConfig, retries - 1, delay * 1.5); // Slower backoff for server errors
        }
        console.error("[DraftEmailLambda] Gemini API call failed after retries or due to non-retryable error:", error.response ? { status: error.response.status, data: error.response.data } : error.message);
        throw error;
    }
}

exports.handler = async (event) => {
    console.log("[DraftEmailLambda] Received event:", JSON.stringify(event, null, 2));
    let taskId, rewrite_instructions; // current_draft_body will be fetched
    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
        // taskId might also come from pathParameters if invoked via API Gateway with {taskId} in path
        taskId = body.taskId || event.pathParameters?.taskId;
        rewrite_instructions = body.rewrite_instructions;

        if (!taskId) throw new Error("Missing taskId");
        
        console.log(`[DraftEmailLambda] Processing request for taskId: ${taskId}${rewrite_instructions ? ' (Rewrite requested)' : ''}`);
    } catch (parseError) {
        console.error("[DraftEmailLambda] Error parsing taskId from request:", parseError, "Event:", event);
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid request: Missing or invalid taskId" }) };
    }

    const dbClient = await pool.connect();
    try {
        const taskDetails = await getTaskDetails(dbClient, taskId);
        const { user_id: userId, source_id: originalEmailS3Key } = taskDetails;
        console.log(`[DraftEmailLambda] User ID: ${userId}, Original Email S3 Key: ${originalEmailS3Key}`);

        if (!originalEmailS3Key || !originalEmailS3Key.startsWith('raw_data/gmail/')) {
            throw new Error(`Invalid source_id for Gmail task: ${originalEmailS3Key}. Must be an S3 key.`);
        }
        const originalRawEmailObject = await getS3Object(S3_RAW_BUCKET_NAME, originalEmailS3Key);
        // The S3 object is ALREADY processed by the sync lambda, so direct assignment is correct.
        const originalEmailTransformed = originalRawEmailObject; 
        console.log(`[DraftEmailLambda] Fetched original email ID ${originalEmailTransformed.id} from S3.`); // Log message adjusted
        console.log(`[DraftEmailLambda] Original Email Content - From: "${originalEmailTransformed.from}", Subject: "${originalEmailTransformed.subject}", BodyText Length: ${originalEmailTransformed.bodyText?.length || 0}, BodyHtml Length: ${originalEmailTransformed.bodyHtml?.length || 0}`);

        const userInfo = await getUserDetails(dbClient, userId);
        const userNameForPrompt = userInfo.name || "Alex Lee"; // Use fetched name or default
        const userGmailCredentials = userInfo.credentials;
        console.log(`[DraftEmailLambda] User details fetched for: ${userNameForPrompt}`);

        const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
        oauth2Client.setCredentials({
            access_token: userGmailCredentials.accessToken,
            refresh_token: userGmailCredentials.refreshToken,
        });
        
        let newCredsForDB = { ...userGmailCredentials };
        let tokenRefreshed = false;
        oauth2Client.on('tokens', (tokens) => {
            console.log(`[DraftEmailLambda] User ${userId}: Gmail tokens event.`);
            if (tokens.access_token) { newCredsForDB.accessToken = tokens.access_token; tokenRefreshed = true; }
            if (tokens.refresh_token) { newCredsForDB.refreshToken = tokens.refresh_token; tokenRefreshed = true; }
        });

        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        // Fetch Thread Context (Simplified: get 1 previous message in thread if original is a reply)
        let threadMessagesFormatted = "No previous messages in this thread were processed or found relevant.";
        if (originalEmailTransformed.inReplyTo || (originalEmailTransformed.references && originalEmailTransformed.references.length > 0)) {
            try {
                 // Simplified: Fetch the thread and get the message just before the current one.
                 // A more robust solution would be to list messages in the thread and pick the one with a date just before originalEmailTransformed.internalDate
                const threadRes = await gmail.users.threads.get({
                    userId: 'me',
                    id: originalEmailTransformed.threadId,
                    format: 'full' // Get full messages in thread
                });
                if (threadRes.data && threadRes.data.messages && threadRes.data.messages.length > 1) {
                    // Find the current email in the thread's messages by ID
                    const currentEmailIndexInThread = threadRes.data.messages.findIndex(m => m.id === originalEmailTransformed.id);
                    if (currentEmailIndexInThread > 0) { // If current is not the first message
                        const previousMessageRaw = threadRes.data.messages[currentEmailIndexInThread - 1];
                        const previousMessageTransformed = transformRawEmail(String(userId), previousMessageRaw);
                        threadMessagesFormatted = `---\nPrevious Message in Thread:\nFrom: ${previousMessageTransformed.from || 'N/A'}\nSubject: ${previousMessageTransformed.subject || '(No Subject)'}\nBody:\n${previousMessageTransformed.bodyText || previousMessageTransformed.bodyHtml || '(No body content)'}\n---
`;
                        console.log(`[DraftEmailLambda] Fetched 1 previous message from thread ${originalEmailTransformed.threadId}`);
                    } else {
                        console.log(`[DraftEmailLambda] Current email is the first in thread ${originalEmailTransformed.threadId} or not found in direct thread list.`);
                    }
                }
            } catch (threadErr) {
                console.warn(`[DraftEmailLambda] Error fetching thread context for ${originalEmailTransformed.threadId}:`, threadErr.message);
                if (threadErr.code === 401) tokenRefreshed = true;
            }
        }

        // Fetch User's Relevant Sent Emails
        let sentEmailsFormatted = "No relevant past sent emails found or processed.";
        const originalSenderEmailAddress = extractEmailAddress(originalEmailTransformed.from);
        console.log(`[DraftEmailLambda] Attempting to find sent emails. Original Sender (parsed): "${originalSenderEmailAddress}"`);
        
        if (originalSenderEmailAddress) {
            console.log(`[DraftEmailLambda] Original sender: ${originalSenderEmailAddress}. Fetching user's sent emails to them.`);
            try {
                const sentMessagesRes = await gmail.users.messages.list({
                    userId: "me",
                    q: `to:"${originalSenderEmailAddress}" from:me`, // More precise query
                    maxResults: 5,
                });

                const sentMessages = [];
                if (sentMessagesRes.data.messages && sentMessagesRes.data.messages.length > 0) {
                    console.log(`[DraftEmailLambda] Found ${sentMessagesRes.data.messages.length} sent message(s) to ${originalSenderEmailAddress}.`);
                    for (const msgMeta of sentMessagesRes.data.messages) {
                        const msgRes = await gmail.users.messages.get({ userId: "me", id: msgMeta.id, format: "full" });
                        sentMessages.push(transformRawEmail(String(userId), msgRes.data));
                    }
                }

                if (sentMessages.length > 0) {
                    sentEmailsFormatted = "";
                    sentMessages.forEach((sentEmail, index) => {
                        sentEmailsFormatted += `--- Example ${index + 1} (${userNameForPrompt} replying to ${originalSenderEmailAddress}): ---\n`;
                        sentEmailsFormatted += `To: ${(sentEmail.to || []).join(', ')}\n`;
                        sentEmailsFormatted += `Subject: ${sentEmail.subject || '(No Subject)'}\n`;
                        sentEmailsFormatted += "Body:\n";
                        sentEmailsFormatted += `${sentEmail.bodyText || sentEmail.bodyHtml || '(No body content found)'}\n`;
                    });
                     sentEmailsFormatted += "---";
                     console.log(`[DraftEmailLambda] Found and formatted ${sentMessages.length} sent emails for the prompt.`);
                } else {
                     console.log(`[DraftEmailLambda] No sent messages found from user to ${originalSenderEmailAddress}.`);
                }
            } catch (sentFetchError) {
                console.error(`[DraftEmailLambda] Error fetching sent emails to ${originalSenderEmailAddress}:`, sentFetchError.message);
                if (sentFetchError.code === 401) tokenRefreshed = true;
            }
        } else {
            console.warn(`[DraftEmailLambda] Could not extract original sender email address from:`, originalEmailTransformed.from);
        }

        if (tokenRefreshed) {
            try {
                console.log(`[DraftEmailLambda] User ${userId}: Credentials possibly refreshed. Updating in DB.`);
                await dbClient.query(
                    "UPDATE users SET connected_apps = jsonb_set(connected_apps, '{gmail}', $1::jsonb, true) WHERE id = $2",
                    [JSON.stringify(newCredsForDB), userId]
                );
                console.log(`[DraftEmailLambda] User ${userId}: Updated Gmail credentials in DB.`);
            } catch (dbUpdateError) {
                console.error(`[DraftEmailLambda] User ${userId}: Failed to update Gmail credentials in DB:`, dbUpdateError);
            }
        }

        const userPreferencesFormatted = `
--- ${userNameForPrompt.split(' ')[0]}'S KNOWN PREFERENCES (Simulated for this draft) ---
- ${userNameForPrompt.split(' ')[0]} generally prefers a [professional/casual/concise/detailed] tone. (You will infer this from examples)
- When replying to external clients like [Original Sender's Company, if known from email signature or domain], ${userNameForPrompt.split(' ')[0]} is typically more formal.
- ${userNameForPrompt.split(' ')[0]} often [uses bullet points for action items / includes a polite closing like 'Best regards']. (Infer from examples)
- Style notes: User is generally formal. Often uses emojis with close colleagues. Prefers short replies to internal team members.
--- END ${userNameForPrompt.split(' ')[0]}'S KNOWN PREFERENCES ---`;

        const originalEmailBodyForPrompt = originalEmailTransformed.bodyText || originalEmailTransformed.bodyHtml || "(Could not extract body)";
        console.log(`[DraftEmailLambda] Details for Prompt - OriginalFrom: "${originalEmailTransformed.from || 'N/A'}", OriginalSubject: "${originalEmailTransformed.subject || '(No Subject)'}", OriginalBodyPreview: "${originalEmailBodyForPrompt.substring(0, 100)}..."`);
        
        let prompt;
        let current_draft_body_for_rewrite = null;

        if (rewrite_instructions) {
            // For a rewrite, fetch the current draft from the DB first.
            const taskDataForRewrite = await dbClient.query("SELECT generated_draft FROM tasks WHERE id = $1", [taskId]);
            if (taskDataForRewrite.rows.length === 0 || !taskDataForRewrite.rows[0].generated_draft) {
                throw new Error(`Cannot rewrite draft for task ${taskId}: No existing draft found or draft is empty.`);
            }
            current_draft_body_for_rewrite = taskDataForRewrite.rows[0].generated_draft;
            console.log(`[DraftEmailLambda] Fetched current draft for rewrite (length: ${current_draft_body_for_rewrite.length}) for task ${taskId}`);
        }

        if (rewrite_instructions && current_draft_body_for_rewrite) {
            // Construct prompt for REWRITE
            prompt = `
You are an AI personal assistant for user ${userNameForPrompt}. Your goal is to revise an email draft based on new instructions, while maintaining ${userNameForPrompt}'s authentic communication style.

The user, ${userNameForPrompt}, wants to REVISE the following DRAFT in response to the ORIGINAL EMAIL below. Please use all the provided context.

--- ORIGINAL RECEIVED EMAIL (Task Source) ---
From: ${originalEmailTransformed.from || 'N/A'}
To: ${(originalEmailTransformed.to || ['N/A']).join(', ')}
Subject: ${originalEmailTransformed.subject || '(No Subject)'}
Date: ${originalEmailTransformed.internalDate || 'N/A'}
Body:
${originalEmailBodyForPrompt}
--- END ORIGINAL RECEIVED EMAIL ---

--- PREVIOUS MESSAGES IN THIS THREAD (If any) ---
${threadMessagesFormatted}
--- END PREVIOUS MESSAGES ---

--- EXAMPLES OF ${userNameForPrompt.split(' ')[0]}'S PAST SENT EMAILS (For Style Reference) ---
${sentEmailsFormatted}
--- END EXAMPLES OF ${userNameForPrompt.split(' ')[0]}'S PAST SENT EMAILS ---

${userPreferencesFormatted}

--- PREVIOUSLY GENERATED DRAFT TO REVISE ---
${current_draft_body_for_rewrite}
--- END PREVIOUSLY GENERATED DRAFT ---

--- USER'S INSTRUCTIONS FOR REWRITING THIS DRAFT ---
${rewrite_instructions}
--- END USER'S INSTRUCTIONS ---

Based on the new instructions AND all the previous context (original email, thread, examples, preferences), please provide a revised email draft FROM ${userNameForPrompt}.

The revised reply should:
1. Incorporate the user's rewrite instructions effectively.
2. Directly address the main points, questions, or requests in the original received email if the instructions modify this aspect.
3. Mimic ${userNameForPrompt.split(' ')[0]}'s typical writing style, tone, and common phrasing as demonstrated in the examples and previous draft.
4. Be ready to send. Conclude the email with a closing like 'Best regards,' followed by ${userNameForPrompt.split(' ')[0]}'s name. Do not add any other signature block elements unless naturally part of the examples.

Output ONLY the body of the REVISED email draft that ${userNameForPrompt} would send. Do not include a subject line prefix like "Re:".
            `;
        } else {
            // Construct prompt for NEW DRAFT (existing logic)
            prompt = `
You are an AI personal assistant for user ${userNameForPrompt}. You have been trained on ${userNameForPrompt}'s communication style and preferences. Your goal is to draft email replies that sound authentically like ${userNameForPrompt} would write them.

The user, ${userNameForPrompt}, wants to draft a reply to the following email:

--- ORIGINAL RECEIVED EMAIL (Task Source) ---
From: ${originalEmailTransformed.from || 'N/A'}
To: ${(originalEmailTransformed.to || ['N/A']).join(', ')}
Subject: ${originalEmailTransformed.subject || '(No Subject)'}
Date: ${originalEmailTransformed.internalDate || 'N/A'}
Body:
${originalEmailBodyForPrompt}
--- END ORIGINAL RECEIVED EMAIL ---

--- PREVIOUS MESSAGES IN THIS THREAD (If any) ---
${threadMessagesFormatted}
--- END PREVIOUS MESSAGES ---

--- EXAMPLES OF ${userNameForPrompt.split(' ')[0]}'S PAST SENT EMAILS (For Style Reference) ---
${sentEmailsFormatted}
--- END EXAMPLES OF ${userNameForPrompt.split(' ')[0]}'S PAST SENT EMAILS ---

${userPreferencesFormatted}

Based on the original received email, the conversation thread, ${userNameForPrompt.split(' ')[0]}'s past email examples, and ${userNameForPrompt.split(' ')[0]}'s preferences, please draft a reply FROM ${userNameForPrompt}.

The reply should:
1. Directly address the main points, questions, or requests in the original received email.
2. Mimic ${userNameForPrompt.split(' ')[0]}'s typical writing style, tone, and common phrasing as demonstrated in the examples. If no examples are available, use a standard professional style.
3. Incorporate ${userNameForPrompt.split(' ')[0]}'s known preferences, using the examples as the primary guide.
4. Be ready to send. Conclude the email with a closing like 'Best regards,' followed by ${userNameForPrompt.split(' ')[0]}'s name. Do not add any other signature block elements (like job titles or phone numbers) unless they are naturally part of the provided examples).

Output ONLY the body of the email draft that ${userNameForPrompt} would send. Do not include a subject line prefix like "Re:".
            `;
        }

        console.log(`[DraftEmailLambda] Sending prompt to Gemini for taskId: ${taskId}. Prompt length: ${prompt.length}`);
        // console.log("GEMINI PROMPT (Excerpt):", prompt.substring(0, 1000)); 

        // Replace direct axios.post with callGeminiWithRetry
        const geminiAxiosConfig = {
            method: 'post',
            url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`,
            data: {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.4 } 
            },
            headers: { 'Content-Type': 'application/json' }
        };
        const geminiResponse = await callGeminiWithRetry(geminiAxiosConfig);

        let draftedEmailBody = "";
        if (geminiResponse.data && geminiResponse.data.candidates && geminiResponse.data.candidates.length > 0) {
            const candidate = geminiResponse.data.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0 && candidate.content.parts[0].text) {
                 draftedEmailBody = candidate.content.parts[0].text;
            } else if (candidate.finishReason === "SAFETY") {
                throw new Error("Draft generation failed due to safety settings.");
            } else if (candidate.finishReason && candidate.finishReason !== "STOP") {
                throw new Error(`Draft generation failed due to: ${candidate.finishReason}`);
            }
        }
        if (!draftedEmailBody) {
            throw new Error("Gemini returned an empty draft.");
        }
        
        console.log(`[DraftEmailLambda] Successfully drafted email for taskId: ${taskId}.`);

        // Store the draft in the database
        if (draftedEmailBody) {
            try {
                await dbClient.query(
                    "UPDATE tasks SET generated_draft = $1, updated_at = now() WHERE id = $2",
                    [draftedEmailBody.trim(), taskId]
                );
                console.log(`[DraftEmailLambda] Successfully stored draft for task ID ${taskId}`);

                // Fetch the updated task to return it
                const updatedTaskResult = await dbClient.query(
                    "SELECT id, user_id, title, description, priority, todo_order, due_date, source_id, generated_draft, is_completed, created_at, updated_at, source_metadata FROM tasks WHERE id = $1", 
                    [taskId]
                );

                if (updatedTaskResult.rows.length === 0) {
                    console.error(`[DraftEmailLambda] Failed to retrieve task ${taskId} after updating draft.`);
                    // Even if retrieval fails, the draft was stored. Return success but without the task object.
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            message: "Draft generation and storage successful, but failed to retrieve updated task details.",
                            draftEmailBody: draftedEmailBody.trim(),
                            taskId: taskId
                        }),
                        headers: { "Content-Type": "application/json" }
                    };
                }
                const updatedTask = updatedTaskResult.rows[0];

                return {
                    statusCode: 200,
                    body: JSON.stringify({ 
                        message: "Draft generation and storage successful.",
                        task: updatedTask // Return the full task object
                    }),
                    headers: { "Content-Type": "application/json" }
                };

            } catch (dbUpdateError) {
                console.error(`[DraftEmailLambda] Error storing draft or fetching updated task for task ID ${taskId}:`, dbUpdateError);
                throw dbUpdateError; 
            }
        } else {
            // This case should ideally not be reached if a draft was expected to be generated.
            // If Gemini returned empty, an error was already thrown.
            // However, as a fallback, if draftedEmailBody is somehow empty here:
            return {
                statusCode: 200, // Or 500 if this state is considered an error
                body: JSON.stringify({
                    message: "Draft generation was successful but resulted in an empty draft. No draft stored.",
                    taskId: taskId
                }),
                headers: { "Content-Type": "application/json" }
            };
        }

    } catch (error) {
        console.error(`[DraftEmailLambda] Error for taskId ${taskId}:`, error.message, error.stack);
        return {
            statusCode: error.message.includes("not found") ? 404 : (error.message.includes("Invalid source_id") ? 400 : 500),
            body: JSON.stringify({ error: error.message }),
            headers: { "Content-Type": "application/json" }
        };
    } finally {
        if (dbClient) {
            dbClient.release();
            console.log("[DraftEmailLambda] Database client released.");
        }
    }
};