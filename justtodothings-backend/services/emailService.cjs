"use strict";

const AWS = require("aws-sdk");
const { RESET_PASSWORD_HTML_TEMPLATE, VERIFICATION_EMAIL_TEMPLATE } = require("../config/emailTemplate.cjs");

async function sendResetEmailHTML(toEmail, resetId) {
    const resetLink = `${process.env.APP_BASE_URL}/reset-password/${resetId}`;
    const htmlBody = RESET_PASSWORD_HTML_TEMPLATE.replace(/{{RESET_PASSWORD_URL}}/g, resetLink);
    const params = {
      Source: process.env.EMAIL_SENDER,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: "Reset Your justtodothings Password" },
        Body: { Html: { Data: htmlBody } }
      }
    };
    const ses = new AWS.SES({ region: "us-east-2" });
    try {
      await ses.sendEmail(params).promise();
      console.log(`[sendResetEmailHTML] Sent reset email to ${toEmail}`);
    } catch (err) {
      console.error("[sendResetEmailHTML] Error:", err);
      throw err;
    }
  }
  
  async function sendVerificationEmail(toEmail, verificationToken) {
    const verificationLink = `${process.env.APP_BASE_URL}/verification/${verificationToken}`;
    const htmlBody = VERIFICATION_EMAIL_TEMPLATE.replace(/{{VERIFICATION_URL}}/g, verificationLink);
    const params = {
      Source: process.env.EMAIL_SENDER,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: "Verify Your justtodothings Email" },
        Body: { Html: { Data: htmlBody } }
      }
    };
    const ses = new AWS.SES({ region: process.env.AWS_REGION || "us-east-2" });
    try {
      await ses.sendEmail(params).promise();
      console.log(`Verification email sent to ${toEmail}`);
    } catch (err) {
      console.error("Error sending verification email:", err);
      throw err;
    }
  }

module.exports = {
    sendResetEmailHTML,
    sendVerificationEmail
};