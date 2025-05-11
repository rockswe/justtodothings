"use strict";

const { pool } = require("../config/db.cjs");
const { buildResponse } = require("../utils/responseHelper.cjs");
const { getUserIdFromToken } = require("../services/tokenService.cjs");

// GET /settings
  // Fetches user’s current settings from the users table, including connected apps.
  async function getSettings(event) {
    const userId = await getUserIdFromToken(event);
    if (!userId) {
      return buildResponse(401, { message: "Unauthorized" });
    }

    const client = await pool.connect();
    try {
      const query = `
        SELECT theme_preference, notifications_enabled, connected_apps
        FROM users
        WHERE id = $1
      `;
      const result = await client.query(query, [userId]);
      if (result.rows.length === 0) {
        return buildResponse(404, { message: "User not found." });
      }
      const { theme_preference, notifications_enabled, connected_apps } = result.rows[0];
      return buildResponse(200, { theme_preference, notifications_enabled, connected_apps });
    } catch (err) {
      console.error("[getSettings] Error:", err);
      return buildResponse(500, { message: "Internal server error." });
    } finally {
      client.release();
    }
  }

  
// PATCH /settings
// Updates user’s settings (theme, notifications, and connected_apps)
async function updateSettings(event) {
  const userId = await getUserIdFromToken(event);
  if (!userId) {
    return buildResponse(401, { message: "Unauthorized" });
  }

  const data = JSON.parse(event.body || "{}");
  const { theme_preference, notifications_enabled, connected_apps } = data;

  const client = await pool.connect();
  try {
    const query = `
      UPDATE users
      SET
        theme_preference = COALESCE($1, theme_preference),
        notifications_enabled = COALESCE($2, notifications_enabled),
        connected_apps = COALESCE($3, connected_apps),
        updated_at = now()
      WHERE id = $4
      RETURNING theme_preference, notifications_enabled, connected_apps
    `;
    const values = [
      theme_preference || null,
      typeof notifications_enabled === "boolean" ? notifications_enabled : null,
      connected_apps || null,
      userId,
    ];

    const result = await client.query(query, values);
    if (result.rows.length === 0) {
      return buildResponse(404, { message: "User not found." });
    }
    return buildResponse(200, {
      message: "Settings updated.",
      settings: result.rows[0],
    });
  } catch (err) {
    console.error("[updateSettings] Error:", err);
    return buildResponse(500, { message: "Internal server error." });
  } finally {
    client.release();
  }
}

module.exports = {
    getSettings,
    updateSettings
};