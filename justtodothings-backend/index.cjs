"use strict";

const {
    refreshToken, deleteAccount, signup, login, logout, forgotPassword, resetPassword, verifyEmail,
    googleAuthRedirect, googleAuthCallback, githubAuthRedirect, githubAuthCallback
} = require("./controllers/authController.cjs");
const {
    createTask, listTasks, deleteAllTasks, getTask, updateTask, deleteTask
} = require("./controllers/taskController.cjs");
const {
    getSettings, updateSettings
} = require("./controllers/settingsController.cjs");
const {
    connectCanvas, disconnectCanvas, connectGmail, disconnectGmail
} = require("./controllers/connectedAppsController.cjs");
const { handleContact } = require("./controllers/contactController.cjs");
const { buildResponse } = require("./utils/responseHelper.cjs");


exports.handler = async (event) => {
  try {
    const path = event.rawPath;
    const httpMethod = event.requestContext?.http?.method;

        // Handle CORS Preflight Requests
    if (httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "https://www.justtodothings.com",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
          "Access-Control-Allow-Headers": "content-type,authorization,x-api-key,content-length,x-amz-date,x-requested-with,x-amz-security-token, cookies",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Max-Age": "300"
        },
        body: "",
      };
    }

    // Tasks CRUD
    if (path === "/tasks" && httpMethod === "POST") {
        return await createTask(event); 
      }
    if (path === "/tasks" && httpMethod === "GET") {
        return await listTasks(event);
      }
    if (path === "/tasks" && httpMethod === "DELETE") {
        return await deleteAllTasks(event);
      }
    if (path.startsWith("/tasks/") && httpMethod === "GET") {
        return await getTask(event);
      }
    if (path.startsWith("/tasks/") && httpMethod === "PUT") {
        return await updateTask(event);
      }
    if (path.startsWith("/tasks/") && httpMethod === "DELETE") {
        return await deleteTask(event);
      }
  
      // Settings
    if (path === "/settings" && httpMethod === "GET") {
        return await getSettings(event);
      }
    if (path === "/settings" && httpMethod === "PATCH") {
        return await updateSettings(event);
      }

      // Connect Canvas and Google
    if (path === "/connected-apps/canvas" && httpMethod === "POST") {
        return await connectCanvas(event);
      }
    if (path === "/connected-apps/gmail/callback" && httpMethod === "GET") {
        return await connectGmail(event); // This path was /connected-apps/gmail in original, but handler name connectGmail implies callback
      }

      // Disconnect Canvas and Google
    if (path === "/connected-apps/canvas" && httpMethod === "DELETE") {
        return await disconnectCanvas(event);
      }
    if (path === "/connected-apps/gmail" && httpMethod === "DELETE") {
        return await disconnectGmail(event);
      }

      // Delete Account
    if (path === "/delete-account" && httpMethod === "POST") {
        return await deleteAccount(event);
      }
      
      // CONTACT
    if (path === "/contact" && httpMethod === "POST") {
        return await handleContact(event);
      }

    // Email/Password endpoints
    if (path === "/signup" && httpMethod === "POST") {
      return await signup(event);
    }
    if (path === "/login" && httpMethod === "POST") {
      return await login(event);
    }
    if (path === "/forgot-password" && httpMethod === "POST") {
      return await forgotPassword(event);
    }
    if (path.startsWith("/reset-password/") && httpMethod === "POST") {
      return await resetPassword(event);
    }
    if (path.startsWith("/verification/") && httpMethod === "GET") {
      return await verifyEmail(event);
    }

    // Google OAuth endpoints
    if (path === "/auth/google" && httpMethod === "GET") {
      return await googleAuthRedirect(event);
    }
    if (path === "/auth/google/callback" && httpMethod === "GET") {
      return await googleAuthCallback(event);
    }

    // GitHub OAuth endpoints
    if (path === "/auth/github" && httpMethod === "GET") {
      return await githubAuthRedirect(event);
    }
    if (path === "/auth/github/callback" && httpMethod === "GET") {
      return await githubAuthCallback(event);
    }


    // Refresh token
    if (path === "/refresh-token" && httpMethod === "POST") return await refreshToken(event);

    // Logout
    if (path === "/logout" && httpMethod === "POST") return await logout(event);

    // 404 if no route matched
    return buildResponse(404, { message: "Not Found" });
  } catch (err) {
    console.error("[Global Error]", err);
    return buildResponse(500, { message: "Internal Server Error" });
  }
};