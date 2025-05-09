"use strict";

const Joi = require("joi");

const createTaskSchema = Joi.object({
    title: Joi.string().min(1).max(255).required().messages({
      "string.empty": "Title is required.",
      "any.required": "Title is required."
    }),
    description: Joi.string().max(1000).optional().allow(""),
    priority: Joi.string().valid("low", "medium", "important").optional().default("low"),
    due_date: Joi.date().iso().optional(),
    is_completed: Joi.boolean().optional()
  });
  
  const updateTaskSchema = Joi.object({
    title: Joi.string().min(1).max(255).optional(),
    description: Joi.string().max(1000).optional().allow(""),
    priority: Joi.string().valid("low", "medium", "important").optional(),
    due_date: Joi.date().iso().optional(),
    is_completed: Joi.boolean().optional()
  });

module.exports = {
    createTaskSchema,
    updateTaskSchema
};