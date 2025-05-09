"use strict";

const Joi = require("joi");

// Define a Joi schema for the contact form
const contactSchema = Joi.object({
    name: Joi.string().min(1).max(100).required().messages({
      "string.empty": "Name is required.",
      "any.required": "Name is required."
    }),
    email: Joi.string().email().required().messages({
      "string.email": "Please enter a valid email address.",
      "any.required": "Email is required."
    }),
    message: Joi.string().min(1).max(2000).required().messages({
      "string.empty": "Message is required.",
      "any.required": "Message is required."
    })
  });

module.exports = { contactSchema };