import axios from "axios"
import { storage } from "./storage"

// Base API URL from environment variable
const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.justtodothings.com"

// Create axios instance with default config
const api = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true, // Important for cookies (refresh token)
})

// Track if a token refresh is in progress
let isRefreshing = false
// Queue of requests waiting for token refresh
let refreshSubscribers: ((token: string) => void)[] = []

// Function to add request to the queue
const subscribeTokenRefresh = (callback: (token: string) => void) => {
  refreshSubscribers.push(callback)
}

// Function to notify all subscribers that token refresh is complete
const onTokenRefreshed = (token: string) => {
  refreshSubscribers.forEach((callback) => callback(token))
  refreshSubscribers = []
}

// Function to handle token refresh
export const refreshToken = async (): Promise<string | null> => {
  try {
    const response = await axios.post(`${API_URL}/refresh-token`, {}, { withCredentials: true })

    if (response.data.accessToken) {
      storage.setToken(response.data.accessToken, true)
      return response.data.accessToken
    }
    return null
  } catch (error) {
    // Log the error, clear any potentially inconsistent local token, but do not redirect here.
    // Redirection should be handled by components that require auth or by interceptors for protected routes.
    console.error("Initial token refresh via cookie failed (this is expected for new/anonymous users):", error)
    storage.clearToken()
    return null // Indicate that no session was established
  }
}

// Add request interceptor to include auth token in requests and check for expiration
api.interceptors.request.use(
  async (config) => {
    let token = storage.getToken()

    // If we have a token and it's expired, try to refresh it
    if (token && storage.isTokenExpired(token)) {
      console.log("Token expired, attempting refresh before request")

      // If refresh is already in progress, wait for it to complete
      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeTokenRefresh((newToken) => {
            config.headers.Authorization = `Bearer ${newToken}`
            resolve(config)
          })
        })
      }

      // Start refresh process
      isRefreshing = true
      const newToken = await refreshToken()
      isRefreshing = false

      if (newToken) {
        onTokenRefreshed(newToken)
        token = newToken
      } else {
        // If refresh failed, redirect to login
        return Promise.reject(new Error("Session expired"))
      }
    }

    // Add token to request headers if available
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }

    return config
  },
  (error) => Promise.reject(error),
)

// Add response interceptor to handle 401 errors
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    // If the failed request was to the login endpoint, don't try to refresh token, just reject.
    if (originalRequest.url === `${API_URL}/login` || originalRequest.url === "/login") {
      return Promise.reject(error)
    }

    // If error is 401 and we haven't already tried to refresh
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      // If refresh is already in progress, wait for it to complete
      if (isRefreshing) {
        try {
          return new Promise((resolve) => {
            subscribeTokenRefresh((newToken) => {
              originalRequest.headers.Authorization = `Bearer ${newToken}`
              resolve(api(originalRequest))
            })
          })
        } catch (refreshError) {
          return Promise.reject(refreshError)
        }
      }

      // Start refresh process
      isRefreshing = true
      try {
        const newToken = await refreshToken()
        isRefreshing = false

        if (newToken) {
          onTokenRefreshed(newToken)
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          return api(originalRequest)
        }
      } catch (refreshError) {
        isRefreshing = false
        storage.clearToken()
        if (typeof window !== "undefined") {
          window.location.href = "/login"
        }
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  },
)

// Auth API
export const authAPI = {
  signup: async (email: string, password: string, passwordAgain: string) => {
    try {
      const response = await api.post("/signup", { email, password, passwordAgain })
      return { success: true, message: response.data.message }
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Signup failed. Please try again.",
      }
    }
  },

  login: async (email: string, password: string, rememberMe = false) => {
    try {
      const response = await api.post("/login", { email, password, rememberMe })
      if (response.data.accessToken) {
        storage.setToken(response.data.accessToken, rememberMe)
      }
      return { success: true, message: response.data.message }
    } catch (error: any) {
      storage.clearToken() // Also clear on login failure
      return {
        success: false,
        message: error.response?.data?.message || "Login failed. Please try again.",
      }
    }
  },

  forgotPassword: async (email: string) => {
    try {
      const response = await api.post("/forgot-password", { email })
      return { success: true, message: response.data.message }
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Failed to send reset email. Please try again.",
      }
    }
  },

  resetPassword: async (uuid: string, password: string, passwordAgain: string) => {
    try {
      const response = await api.post(`/reset-password/${uuid}`, { password, passwordAgain })
      return { success: true, message: response.data.message }
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Password reset failed. Please try again.",
      }
    }
  },

  verifyEmail: async (uuid: string) => {
    try {
      const response = await api.get(`/verification/${uuid}`)
      return { success: true, message: response.data.message }
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Email verification failed.",
        error: error.response?.data?.message || "Unknown error",
      }
    }
  },

  logout: async () => {
    try {
      await api.post("/logout")
      storage.clearToken()
      return { success: true }
    } catch (error) {
      // Also clear token even if API logout fails
      storage.clearToken()
      return { success: false }
    }
  },

  deleteAccount: async () => {
    try {
      const response = await api.post("/delete-account")
      storage.clearToken()
      return { success: true, message: response.data.message }
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Failed to delete account. Please try again.",
      }
    }
  },
}

// Task API
export interface Task {
  id: number
  title: string
  description: string
  priority: "low" | "medium" | "important"
  due_date: string
  todo_order: number
  created_at: string
  updated_at: string
  is_completed?: boolean
}

export interface CreateTaskPayload {
  title: string
  description: string
  priority: "low" | "medium" | "important"
  due_date: string
  is_completed?: boolean
}

export interface UpdateTaskPayload {
  title?: string
  description?: string
  priority?: "low" | "medium" | "important"
  due_date?: string
  is_completed?: boolean
}

export const taskAPI = {
  getTasks: async (): Promise<Task[]> => {
    try {
      const response = await api.get("/tasks")
      return response.data.tasks
    } catch (error) {
      console.error("Error fetching tasks:", error)
      return []
    }
  },

  createTask: async (task: CreateTaskPayload): Promise<Task> => {
    const response = await api.post("/tasks", task)
    return response.data.task
  },

  updateTask: async (taskId: number, task: UpdateTaskPayload): Promise<Task> => {
    const response = await api.put(`/tasks/${taskId}`, task)
    return response.data.task
  },

  deleteTask: async (taskId: number): Promise<void> => {
    await api.delete(`/tasks/${taskId}`)
  },

  deleteAllTasks: async (): Promise<void> => {
    await api.delete("/tasks")
  },
}

// Settings API
// Update the UserSettings interface to include GitHub and Slack
export interface UserSettings {
  theme_preference: "dark" | "light"
  notifications_enabled: boolean
  connected_apps?: {
    canvas?: {
      canvasUserId: string
      domain: string
    }
    gmail?: {
      email: string
    }
    github?: {
      id: string
      login: string
    }
    slack?: {
      team_id: string
      user_id: string
    }
  }
}

export const settingsAPI = {
  getSettings: async (): Promise<UserSettings> => {
    try {
      const response = await api.get("/settings")
      return response.data.settings
    } catch (error) {
      console.error("Error fetching settings:", error)
      throw error
    }
  },

  updateSettings: async (updates: Partial<UserSettings>): Promise<UserSettings> => {
    try {
      const response = await api.put("/settings", updates)
      return response.data.settings
    } catch (error) {
      console.error("Error updating settings:", error)
      throw error
    }
  },
}

// Connected Apps API
// Add new methods to the connectedAppsAPI object
export const connectedAppsAPI = {
  connectCanvas: async (domain: string, accessToken: string) => {
    const response = await api.post("/connected-apps/canvas", { domain, accessToken })
    return response.data.connected_apps?.canvas
  },

  disconnectCanvas: async () => {
    const response = await api.delete("/connected-apps/canvas")
    return response.data
  },

  disconnectGmail: async () => {
    const response = await api.delete("/connected-apps/gmail")
    return response.data
  },

  disconnectGitHub: async () => {
    const response = await api.delete("/connected-apps/github")
    return response.data
  },

  disconnectSlack: async () => {
    const response = await api.delete("/connected-apps/slack")
    return response.data
  },
}

// Contact API
export const contactAPI = {
  sendMessage: async (name: string, email: string, message: string) => {
    try {
      const response = await api.post("/contact", { name, email, message })
      return { success: true, message: response.data.message }
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Failed to send message. Please try again.",
      }
    }
  },
}

export default api
