"use strict";

const { pool } = require("../config/db.cjs");
const { buildResponse } = require("../utils/responseHelper.cjs");
const { getUserIdFromToken } = require("../services/tokenService.cjs");
const { createTaskSchema, updateTaskSchema } = require("../validation/taskSchemas.cjs");

// POST /tasks
async function createTask(event) {
    const userId = getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
  
    const data = JSON.parse(event.body || "{}");
    const { error, value } = createTaskSchema.validate(data);
    if (error) return buildResponse(400, { message: error.details[0].message });
    
    const { title, description, priority, due_date, is_completed } = value;
    
    const client = await pool.connect();
    try {
      const query = `
        INSERT INTO tasks (user_id, title, description, priority, due_date, is_completed)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, title, description, priority, due_date, is_completed, created_at, updated_at
      `;
      const values = [userId, title, description || null, priority, due_date || null, is_completed || false];
      const result = await client.query(query, values);
      return buildResponse(201, { message: "Task created.", task: result.rows[0] });
    } catch (err) {
      console.error("[createTask] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release(); 
    }
  }
  
  // GET /tasks
  async function listTasks(event) {
    const userId = getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
  
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, title, description, priority, todo_order, due_date, is_completed, created_at, updated_at
        FROM tasks
        WHERE user_id = $1
        ORDER BY created_at DESC
      `;
      const result = await client.query(query, [userId]);
      return buildResponse(200, { tasks: result.rows });
    } catch (err) {
      console.error("[listTasks] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
  // DELETE /tasks (bulk delete)
  async function deleteAllTasks(event) {
    const userId = getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
  
    const client = await pool.connect();
    try {
      const query = `DELETE FROM tasks WHERE user_id = $1`;
      await client.query(query, [userId]);
      return buildResponse(200, { message: "All tasks deleted." });
    } catch (err) {
      console.error("[deleteAllTasks] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
  // GET /tasks/{task_id}
  async function getTask(event) {
    const userId = getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
  
    const { task_id } = event.pathParameters || {};
    if (!task_id) return buildResponse(400, { message: "Task ID is required." });
  
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, title, description, priority, todo_order, due_date, is_completed, created_at, updated_at
        FROM tasks
        WHERE id = $1 AND user_id = $2
      `;
      const result = await client.query(query, [task_id, userId]);
      if (result.rows.length === 0) return buildResponse(404, { message: "Task not found." });
      return buildResponse(200, { task: result.rows[0] });
    } catch (err) {
      console.error("[getTask] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
  // PUT /tasks/{task_id}
  async function updateTask(event) {
    const userId = getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
  
    const { task_id } = event.pathParameters || {};
    if (!task_id) return buildResponse(400, { message: "Task ID is required." });
  
    const data = JSON.parse(event.body || "{}");
    const { error, value } = updateTaskSchema.validate(data);
    if (error) return buildResponse(400, { message: error.details[0].message });
    
    const { title, description, priority, due_date, is_completed } = value;
    
    const client = await pool.connect();
    try {
      const query = `
      UPDATE tasks
      SET 
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        priority = COALESCE($3, priority),
        due_date = COALESCE($4, due_date),
        is_completed = COALESCE($5, is_completed),
        updated_at = now()
      WHERE id = $6 AND user_id = $7
      RETURNING id, title, description, priority, todo_order, due_date, is_completed, created_at, updated_at
    `;    
      const values = [
        title, 
        description, 
        priority, 
        due_date, 
        is_completed,
        task_id,
        userId
      ];      
      const result = await client.query(query, values);
      if (result.rows.length === 0) return buildResponse(404, { message: "Task not found or not owned by user." });
      return buildResponse(200, { message: "Task updated.", task: result.rows[0] });
    } catch (err) {
      console.error("[updateTask] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }
  
  // DELETE /tasks/{task_id}
  async function deleteTask(event) {
    const userId = getUserIdFromToken(event);
    if (!userId) return buildResponse(401, { message: "Unauthorized" });
  
    const { task_id } = event.pathParameters || {};
    if (!task_id) return buildResponse(400, { message: "Task ID is required." });
  
    const client = await pool.connect();
    try {
      const query = `
        DELETE FROM tasks
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `;
      const result = await client.query(query, [task_id, userId]);
      if (result.rows.length === 0) return buildResponse(404, { message: "Task not found or not owned by user." });
      return buildResponse(200, { message: "Task deleted." });
    } catch (err) {
      console.error("[deleteTask] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }

module.exports = {
    createTask,
    listTasks,
    deleteAllTasks,
    getTask,
    updateTask,
    deleteTask
};