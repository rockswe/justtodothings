// Storage utility for handling auth tokens with remember me functionality
export const storage = {
  getToken: (): string | null => {
    return localStorage.getItem("authToken") || sessionStorage.getItem("authToken")
  },

  setToken: (token: string, rememberMe: boolean): void => {
    if (rememberMe) {
      localStorage.setItem("authToken", token)
      sessionStorage.removeItem("authToken") // Clear session if switching to remember
    } else {
      sessionStorage.setItem("authToken", token)
      localStorage.removeItem("authToken") // Clear local if switching to not remember
    }
  },

  clearToken: (): void => {
    localStorage.removeItem("authToken")
    sessionStorage.removeItem("authToken")
  },

  // Helper to check if a JWT token is expired
  isTokenExpired: (token: string): boolean => {
    if (!token) return true

    try {
      // Get the payload part of the JWT (second part)
      const payload = token.split(".")[1]
      // Decode the base64 string
      const decodedPayload = JSON.parse(atob(payload))
      // Check if the expiration time has passed
      const currentTime = Math.floor(Date.now() / 1000)
      return decodedPayload.exp < currentTime
    } catch (error) {
      console.error("Error checking token expiration:", error)
      return true // If there's any error, consider the token expired
    }
  },
}
