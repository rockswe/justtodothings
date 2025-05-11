"use client"

import type React from "react"

import Link from "next/link"
import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Github, Mail, Eye, EyeOff } from "lucide-react"
import { useTheme } from "../../contexts/ThemeContext"
import { useAuth } from "../../contexts/AuthContext"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [loginError, setLoginError] = useState("")
  const router = useRouter()
  const { theme } = useTheme()
  const { login, isLoading } = useAuth()
  const searchParams = useSearchParams()

  // Handle error parameters from OAuth redirects
  useEffect(() => {
    const error = searchParams.get("error")

    if (error) {
      let errorMessage = "Authentication failed"

      // Map error codes to user-friendly messages
      switch (error) {
        case "invalid_state":
          errorMessage = "Security validation failed. Please try again."
          break
        case "github_no_verified_email":
        case "google_no_email":
          errorMessage = "No verified email found. Please verify your email first."
          break
        case "account_disabled":
          errorMessage = "Your account has been disabled."
          break
        case "github_missing_code":
        case "google_missing_code":
          errorMessage = "Authentication process was interrupted. Please try again."
          break
        case "github_api_error":
        case "google_api_error":
          errorMessage = "Service temporarily unavailable. Please try again later."
          break
        default:
          errorMessage = "Authentication failed. Please try again."
      }

      setLoginError(errorMessage)

      // Remove the error parameter
      const url = new URL(window.location.href)
      url.searchParams.delete("error")
      router.replace(url.pathname + url.search)
    }
  }, [searchParams, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError("")

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setLoginError("Please enter a valid email address (format: name@domain.com)")
      return
    }

    try {
      const result = await login(email, password, rememberMe)
      if (result.success) {
        console.log("Login successful")
        router.push("/")
      } else {
        setLoginError(result.message)
      }
    } catch (error) {
      setLoginError("An error occurred. Please try again.")
    }
  }

  const handleGithubLogin = () => {
    window.location.href = `${process.env.NEXT_PUBLIC_API_URL}/auth/github`
  }

  const handleGoogleLogin = () => {
    window.location.href = `${process.env.NEXT_PUBLIC_API_URL}/auth/google`
  }

  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword)
  }

  return (
    <div className={`min-h-screen ${theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"} font-mono`}>
      <header className="w-full p-4 flex justify-between items-start">
        <Link href="/" className="text-2xl">
          justtodothings
        </Link>
        <div className="space-y-2 text-right">
          <Link href="/login" className="block hover:underline">
            login
          </Link>
          <Link href="/signup" className="block hover:underline">
            sign up
          </Link>
          <Link href="/contact" className="block hover:underline">
            contact
          </Link>
        </div>
      </header>

      <main className="flex flex-col items-center justify-center px-4 pt-20">
        <div className="w-full max-w-md space-y-8">
          <h1 className="text-4xl text-center mb-12">login</h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="email" className="sr-only">
                email
              </Label>
              <div className="relative">
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white ${loginError ? "border-red-500" : ""}`}
                  placeholder="email"
                  required
                  pattern="[^\s@]+@[^\s@]+\.[^\s@]+"
                  title="Please enter a valid email address (format: name@domain.com)"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="sr-only">
                password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white pr-10 ${loginError ? "border-red-500" : ""}`}
                  placeholder="password"
                  required
                />
                <button
                  type="button"
                  className="absolute right-0 top-1/2 transform -translate-y-1/2 text-gray-500"
                  onClick={togglePasswordVisibility}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember"
                checked={rememberMe}
                onCheckedChange={(checked) => setRememberMe(checked as boolean)}
                className={`border ${
                  theme === "dark"
                    ? "border-white data-[state=checked]:bg-white data-[state=checked]:text-black"
                    : "border-black data-[state=checked]:bg-black data-[state=checked]:text-white"
                }`}
              />
              <label
                htmlFor="remember"
                className={`text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 ${
                  theme === "dark" ? "text-white" : "text-black"
                }`}
              >
                remember me
              </label>
            </div>

            {loginError && <p className="text-red-500 text-sm text-center">{loginError}</p>}

            <Button type="submit" variant="outline" className="w-full" disabled={isLoading}>
              {isLoading ? "logging in..." : "login"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full flex items-center justify-center gap-2"
              onClick={handleGithubLogin}
            >
              <Github className="w-5 h-5" />
              login with github
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full flex items-center justify-center gap-2"
              onClick={handleGoogleLogin}
            >
              <Mail className="w-5 h-5" />
              login with google
            </Button>
          </form>

          <div className="text-right">
            <Link href="/forgot-password" className="inline-block">
              <Button variant="outline">forgot my password</Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  )
}
