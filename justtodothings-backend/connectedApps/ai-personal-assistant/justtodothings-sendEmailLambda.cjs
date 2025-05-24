"use strict";

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");
const { google } = require("googleapis");

// Environment Variables
const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT || 5432;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;

const S3_RAW_BUCKET_NAME = process.env.S3_RAW_BUCKET;
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

async function getS3Object(bucket, key) {
    try {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3.send(command);
        const str = await response.Body.transformToString("utf-8");
        return JSON.parse(str);
    } catch (error) {
        console.error(`[SendEmailLambda] Error fetching S3 object s3://${bucket}/${key}:`, error);
        throw error;
    }
}

async function getTaskDetails(dbClient, taskId) {
    const query = "SELECT user_id, source_id FROM tasks WHERE id = $1";
    const { rows } = await dbClient.query(query, [taskId]);
    if (rows.length === 0) {
        throw new Error(`Task with ID ${taskId} not found.`);
    }
    return rows[0];
}

async function getUserDetails(dbClient, userId) {
    const query = "SELECT email, connected_apps->'gmail' AS gmail_creds FROM users WHERE id = $1";
    const { rows } = await dbClient.query(query, [userId]);
    if (rows.length === 0) {
        throw new Error(`User with ID ${userId} not found.`);
    }
    if (!rows[0].gmail_creds || !rows[0].gmail_creds.accessToken) {
        throw new Error(`Gmail credentials (accessToken) not found for user ID ${userId}.`);
    }
    return { 
        user_email_from_db: rows[0].email, // User's primary email in our system
        gmailSpecificEmail: rows[0].gmail_creds.email, // Email associated with this specific Gmail connection
        credentials: rows[0].gmail_creds 
    };
}

function extractEmailAddress(emailHeaderValue) {
    if (!emailHeaderValue) return null;
    const match = emailHeaderValue.match(/<([^>]+)>/);
    return match ? match[1] : emailHeaderValue.trim();
}

exports.handler = async (event) => {
    console.log("[SendEmailLambda] Received event:", JSON.stringify(event, null, 2));
    let taskId, final_email_body;
    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
        taskId = body.taskId || event.pathParameters?.taskId;
        final_email_body = body.final_email_body;
        if (!taskId) throw new Error("Missing taskId");
        if (!final_email_body) throw new Error("Missing final_email_body");
        console.log(`[SendEmailLambda] Processing request for taskId: ${taskId}`);
    } catch (parseError) {
        console.error("[SendEmailLambda] Error parsing request:", parseError, "Event:", event);
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid request: Missing or invalid taskId/final_email_body" }) };
    }

    const dbClient = await pool.connect();
    try {
        const taskDetails = await getTaskDetails(dbClient, taskId);
        const { user_id: userId, source_id: originalEmailS3Key } = taskDetails;
        console.log(`[SendEmailLambda] User ID: ${userId}, Original Email S3 Key: ${originalEmailS3Key}`);

        if (!originalEmailS3Key || !originalEmailS3Key.startsWith('raw_data/gmail/')) {
            throw new Error(`Invalid source_id for Gmail task: ${originalEmailS3Key}.`);
        }
        // This object is the ALREADY PROCESSED email data from S3 (e.g., output of transformRawEmail from sync lambda)
        const originalEmailObject = await getS3Object(S3_RAW_BUCKET_NAME, originalEmailS3Key);
        console.log(`[SendEmailLambda] Fetched original email object for task ${taskId}. ID: ${originalEmailObject.id}`);

        const userInfo = await getUserDetails(dbClient, userId);
        const userGmailCredentials = userInfo.credentials;
        // The user's actual email for the 'From' header when sending via 'me' context in Gmail API
        // is implicitly the one tied to the accessToken. The `userInfo.gmailSpecificEmail` is that address.
        console.log(`[SendEmailLambda] User details fetched. Sending as: ${userInfo.gmailSpecificEmail}`);

        const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
        oauth2Client.setCredentials({
            access_token: userGmailCredentials.accessToken,
            refresh_token: userGmailCredentials.refreshToken,
        });
        
        let newCredsForDB = { ...userGmailCredentials };
        let tokenRefreshed = false;
        oauth2Client.on('tokens', (tokens) => {
            console.log(`[SendEmailLambda] User ${userId}: Gmail tokens event.`);
            if (tokens.access_token) { newCredsForDB.accessToken = tokens.access_token; tokenRefreshed = true; }
            if (tokens.refresh_token) { newCredsForDB.refreshToken = tokens.refresh_token; tokenRefreshed = true; }
        });

        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        // Construct the raw email message
        const originalSenderAddress = extractEmailAddress(originalEmailObject.from);
        if (!originalSenderAddress) {
            throw new Error("Could not extract sender address from original email.");
        }

        let subject = originalEmailObject.subject || "";
        if (!subject.toLowerCase().startsWith("re:")) {
            subject = "Re: " + subject;
        }

        const headers = {
            "To": originalSenderAddress,
            "From": userInfo.gmailSpecificEmail, // This should be the authenticated user's email
            "Subject": subject,
            "In-Reply-To": originalEmailObject.messageIdHeader,
            "References": (originalEmailObject.references || []).join(" ") + (originalEmailObject.references?.length > 0 ? " " : "") + originalEmailObject.messageIdHeader,
            "Content-Type": 'text/plain; charset="UTF-8' // Assuming plain text draft for simplicity; can be text/html if needed
        };

        let email = '';
        for (const header in headers) {
            email += `${header}: ${headers[header]}\r\n`;
        }
        email += "\r\n"; // Empty line between headers and body
        email += final_email_body;

        // Base64URL encode the email
        const encodedMessage = Buffer.from(email).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        console.log(`[SendEmailLambda] Sending email to ${originalSenderAddress} with subject "${subject}"`);

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
                threadId: originalEmailObject.threadId // Ensure it's part of the same thread
            }
        });
        console.log(`[SendEmailLambda] Email sent successfully for task ${taskId}.`);

        // Persist new tokens if they were refreshed
        if (tokenRefreshed) {
            try {
                console.log(`[SendEmailLambda] User ${userId}: Credentials possibly refreshed. Updating in DB.`);
                await dbClient.query(
                    "UPDATE users SET connected_apps = jsonb_set(connected_apps, '{gmail}', $1::jsonb, true) WHERE id = $2",
                    [JSON.stringify(newCredsForDB), userId]
                );
                console.log(`[SendEmailLambda] User ${userId}: Updated Gmail credentials in DB.`);
            } catch (dbUpdateError) {
                console.error(`[SendEmailLambda] User ${userId}: Failed to update Gmail credentials in DB:`, dbUpdateError);
            }
        }

        // Mark task as completed (or other status update as needed)
        try {
            await dbClient.query("UPDATE tasks SET is_completed = true, updated_at = now() WHERE id = $1", [taskId]);
            console.log(`[SendEmailLambda] Task ${taskId} marked as completed.`);
        } catch (taskUpdateError) {
            console.error(`[SendEmailLambda] Error marking task ${taskId} as completed:`, taskUpdateError);
            // Non-fatal, email was sent.
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Email sent successfully and task updated.", taskId: taskId }),
            headers: { "Content-Type": "application/json" }
        };

    } catch (error) {
        console.error(`[SendEmailLambda] Error processing taskId ${taskId}:`, error.message, error.stack);
        return {
            statusCode: error.message.includes("not found") || error.message.includes("Invalid source_id") ? 404 : 500,
            body: JSON.stringify({ error: error.message }),
            headers: { "Content-Type": "application/json" }
        };
    } finally {
        if (dbClient) {
            dbClient.release();
            console.log("[SendEmailLambda] Database client released.");
        }
    }
}; 