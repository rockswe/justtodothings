"use strict";

const Joi = require("joi");

// Define a password complexity schema
const passwordComplexity = Joi.string().min(8)
  .pattern(new RegExp("^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[!@#$%^&*()_+\\-=\\[\\]{};':\"\\\\|,.<>\\/?]).+$"))
  .required()
  .messages({
    "string.min": "Password must be at least 8 characters long.",
    "string.pattern.base": "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character.",
    "any.required": "Password is required."
  });

// Signup schema
const signupSchema = Joi.object({
  email: Joi.string().email().required().messages({
    "string.email": "Please enter a valid email address.",
    "any.required": "Email is required."
  }),
  password: passwordComplexity,
  passwordAgain: passwordComplexity
});

// Login schema
const loginSchema = Joi.object({
    email: Joi.string().email().required().messages({
      "string.email": "Please enter a valid email address.",
      "any.required": "Email is required."
    }),
    password: Joi.string().required().messages({
      "any.required": "Password is required."
    }),
    rememberMe: Joi.boolean().optional().default(false)
  });

// Forgot Password schema
const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required().messages({
    "string.email": "Please enter a valid email address.",
    "any.required": "Email is required."
  })
});

// Reset Password schema
const resetPasswordSchema = Joi.object({
  password: passwordComplexity,
  passwordAgain: passwordComplexity
});

module.exports = {
    signupSchema,
    loginSchema,
    forgotPasswordSchema,
    resetPasswordSchema
};