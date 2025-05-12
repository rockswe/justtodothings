"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT || 5432,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
});

// ADMIN: Reset (truncate) users table
async function resetUsersTable() {
  const client = await pool.connect();
  try {
    await client.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
    return { message: "Users table has been reset." };
  } finally {
    client.release();
  }
}

// ADMIN: List users who connected their Canvas account with metadata
async function getCanvasConnectedUsers() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        id,
        email,
        created_at,
        connected_apps->'canvas' AS canvas_info,
        connected_apps->'canvas'->>'domain' AS canvas_domain,
        connected_apps->'canvas'->>'last_synced_at' AS last_synced_at,
        connected_apps->'canvas'->>'access_token' IS NOT NULL AS has_token
      FROM users
      WHERE connected_apps ? 'canvas'
      ORDER BY id
    `);
    return result.rows;
  } finally {
    client.release();
  }
}

// … up at the top with your other helpers …

// ADMIN: Delete a user by email
async function deleteUserByEmail(email) {
  const client = await pool.connect();
  try {
    const query = "DELETE FROM users WHERE email = $1 RETURNING id";
    const result = await client.query(query, [email.toLowerCase()]);
    if (result.rowCount === 0) {
      return { message: "No user found with that email." };
    }
    return { message: "User deleted successfully.", userId: result.rows[0].id };
  } finally {
    client.release();
  }
}

// ADMIN: List all users
async function getAllUsers() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, email, created_at
       FROM users
       ORDER BY id`
    );
    // return the array of user objects directly
    return result.rows;
  } finally {
    client.release();
  }
}

// ADMIN: Add is_completed column to tasks table
async function alterTasksTableForCompletion() {
  const client = await pool.connect();
  try {
    const sql = `
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS is_completed BOOLEAN NOT NULL DEFAULT false;
    `;
    await client.query(sql);
    return { message: "'is_completed' column added to tasks table successfully." };
  } catch (err) {
    console.error("❌ Error altering tasks table:", err);
    throw err;
  } finally {
    client.release();
  }
}

// ADMIN: Reset all tables
async function resetAllTables() {
  const client = await pool.connect();
  try {
    await client.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE TABLE email_verifications RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE TABLE password_resets RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE TABLE tasks RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE TABLE refresh_tokens RESTART IDENTITY CASCADE");
    return { message: "All tables have been reset." };
  } finally {
    client.release();
  }
}

// Lambda handler
exports.handler = async (event) => {
  try {
    const operation = event.operation;

    switch (operation) {
      case "resetUsersTable": {
        const result = await resetUsersTable();
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case "deleteUserByEmail": {
        if (!event.email) {
          return {
            statusCode: 400,
            body: JSON.stringify({ message: "Email is required for deleteUserByEmail." }),
          };
        }
        const result = await deleteUserByEmail(event.email);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case "getAllUsers": {
        const users = await getAllUsers();
        return {
          statusCode: 200,
          body: JSON.stringify({ users }),
        };
      }

      case "getCanvasConnectedUsers": {
        const users = await getCanvasConnectedUsers();
        return {
          statusCode: 200,
          body: JSON.stringify({ users }),
        };
      }

      case "alterTasksTableForCompletion": {
        const result = await alterTasksTableForCompletion();
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case "resetAllTables": {
        const result = await resetAllTables();
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      // you can add more admin operations here...
      default: {
        return {
          statusCode: 400,
          body: JSON.stringify({
            message:
              "Unknown operation. Valid ops are 'resetUsersTable', 'deleteUserByEmail', 'getAllUsers', 'alterTasksTableForCompletion', 'resetAllTables'.",
          }),
        };
      }
    }
  } catch (error) {
    console.error("🔥 Admin Lambda error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error", error: error.message }),
    };
  }
};
