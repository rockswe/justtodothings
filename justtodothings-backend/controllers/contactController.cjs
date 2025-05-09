"use strict";

const AWS = require("aws-sdk");
const { buildResponse } = require("../utils/responseHelper.cjs");
const { contactSchema } = require("../validation/contactSchema.cjs");

// Contact handler for POST /contact
async function handleContact(event) {
    // Parse the incoming JSON body
    const data = JSON.parse(event.body || "{}");
  
    // Validate using Joi
    const { error, value } = contactSchema.validate(data);
    if (error) {
      return buildResponse(400, { message: error.details[0].message });
    }
    const { name, email, message } = value;
  
    // Build the email content
    const subject = `Contact Form from ${name}`;
    const bodyText = `
  Name: ${name}
  Email: ${email}
  
  Message:
  ${message}
    `;
  
    // Prepare AWS SES parameters
    const params = {
      Source: process.env.EMAIL_SENDER || "noreply@justtodothings.com",
      Destination: {
        ToAddresses: [process.env.CONTACT_DESTINATION_EMAIL || "me@efekaya.co"],
      },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: bodyText } },
      },
    };
  
    // Send the email via SES
    try {
      const ses = new AWS.SES({ region: "us-east-2" });
      await ses.sendEmail(params).promise();
      console.log("[handleContact] Sent contact form email to support address.");
      return buildResponse(200, { message: "Thank you for contacting us. We'll get back to you soon." });
    } catch (err) {
      console.error("[handleContact] Error sending contact email:", err);
      return buildResponse(500, { message: "Failed to send contact email. Please try again later." });
    }
  }

module.exports = {
    handleContact
};