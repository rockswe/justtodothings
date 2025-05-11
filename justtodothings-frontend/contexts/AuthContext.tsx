"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"
import { authAPI, refreshToken as refreshAuthTokenAPICall } from "@/services/api"
import { useRouter } from "next/navigation"
// Import the storage utility at the top of the file
import { storage } from "@/services/storage"

interface AuthContextType {
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string, rememberMe?: boolean) => Promise<{ success: boolean; message: string }>
  signup: (email: string, password: string, passwordAgain: string) => Promise<{ success: boolean; message: string }>
  logout: () => void
  forgotPassword: (email: string) => Promise<{ success: boolean; message: string }>
  resetPassword: (
    uuid: string,
    password: string,
    passwordAgain: string,
  ) => Promise<{ success: boolean; message: string }>
  deleteAccount: () => Promise<{ success: boolean; message: string }>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const router = useRouter()

  useEffect(() => {
    const initializeAndCheckAuth = async () => {
      setIsLoading(true) // Ensure loading state is true during initialization
      const token = storage.getToken()
      let isTokenCurrentlyValid = false

      if (token && !storage.isTokenExpired(token)) {
        isTokenCurrentlyValid = true
      }

      // Check for oauth_success in URL to ensure we attempt a refresh
      const urlParams = new URLSearchParams(window.location.search)
      const oauthSuccess = urlParams.get("oauth_success")

      if (isTokenCurrentlyValid) {
        console.log("AuthProvider: Valid token found in storage.")
        setIsAuthenticated(true)
      } else {
        if (token) {
          console.log("AuthProvider: Token found in storage but is expired. Attempting refresh.")
        } else if (oauthSuccess) {
          console.log("AuthProvider: OAuth success detected. Attempting to get token from refresh cookie.")
        } else {
          console.log(
            "AuthProvider: No token in storage. Attempting initial refresh via cookie (expected for OAuth redirects or returning users with cookie).",
          )
        }
        try {
          const newAccessToken = await refreshAuthTokenAPICall() // Call the imported refreshToken
          if (newAccessToken) {
            console.log("AuthProvider: Token successfully refreshed/obtained.")
            setIsAuthenticated(true)
            // The refreshAuthTokenAPICall already calls storage.setToken()
          } else {
            console.log("AuthProvider: Attempt to refresh/obtain token did not yield an access token.")
            // No server session, ensure local state reflects this
            storage.clearToken() // Ensure no invalid token lingers if refresh failed to produce one
            setIsAuthenticated(false)
          }
        } catch (error) {
          console.error("AuthProvider: Error during token refresh/obtain attempt:", error)
          storage.clearToken() // Ensure no invalid token lingers on error
          setIsAuthenticated(false)
        }
      }
      setIsLoading(false) // Set loading to false after all checks and attempts
    }

    initializeAndCheckAuth()

    // Listen for storage events (for multi-tab support)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "authToken") {
        // Re-check auth status based on the new token state from another tab
        const currentToken = storage.getToken()
        setIsAuthenticated(!!currentToken && !storage.isTokenExpired(currentToken ?? ""))
      }
    }

    window.addEventListener("storage", handleStorageChange)
    return () => window.removeEventListener("storage", handleStorageChange)
  }, []) // Run once on mount

  const login = async (email: string, password: string, rememberMe = false) => {
    try {
      setIsLoading(true)
      const result = await authAPI.login(email, password, rememberMe)
      if (result.success) {
        setIsAuthenticated(true)
        // router.push("/") // Removed: LoginPage will handle navigation
      }
      // If login fails (result.success is false), isAuthenticated remains unchanged (false or its previous state)
      return result
    } catch (error: any) {
      // On actual error (e.g., network issue, or if authAPI.login throws instead of returning {success:false})
      // isAuthenticated should not be set to true.
      return {
        success: false,
        message: error.response?.data?.message || "Login failed. Please try again.",
      }
    } finally {
      setIsLoading(false)
    }
  }

  const signup = async (email: string, password: string, passwordAgain: string) => {
    try {
      setIsLoading(true)
      const result = await authAPI.signup(email, password, passwordAgain)
      return result
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Signup failed. Please try again.",
      }
    } finally {
      setIsLoading(false)
    }
  }

  // Update the logout function to ensure token clearing
  const logout = async () => {
    setIsLoading(true)
    try {
      await authAPI.logout() // This already calls storage.clearToken()
    } catch (error) {
      console.error("Logout API call failed, clearing token locally anyway.", error)
      storage.clearToken() // Ensure cleanup even if API fails
    } finally {
      storage.clearToken() // Belt-and-suspenders approach
      setIsAuthenticated(false)
      router.push("/login")
      setIsLoading(false)
    }
  }

  const forgotPassword = async (email: string) => {
    try {
      setIsLoading(true)
      const result = await authAPI.forgotPassword(email)
      return result
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Failed to send reset email. Please try again.",
      }
    } finally {
      setIsLoading(false)
    }
  }

  const resetPassword = async (uuid: string, password: string, passwordAgain: string) => {
    try {
      setIsLoading(true)
      const result = await authAPI.resetPassword(uuid, password, passwordAgain)
      return result
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.message || "Password reset failed. Please try again.",
      }
    } finally {
      setIsLoading(false)
    }
  }

  // Update the deleteAccount function to ensure token clearing
  const deleteAccount = async () => {
    try {
      setIsLoading(true)
      const result = await authAPI.deleteAccount() // This already calls storage.clearToken()
      if (result.success) {
        storage.clearToken() // Ensure token is cleared
        setIsAuthenticated(false)
        router.push("/login")
      }
      return result
    } catch (error: any) {
      console.error("Delete account API call failed, clearing token locally anyway.", error)
      storage.clearToken() // Ensure cleanup even if API fails
      return {
        success: false,
        message: error.response?.data?.message || "Failed to delete account. Please try again.",
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        login,
        signup,
        logout,
        forgotPassword,
        resetPassword,
        deleteAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
