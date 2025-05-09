"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Eye, EyeOff } from "lucide-react"
import { useTheme } from "../../../contexts/ThemeContext"
import { useAuth } from "../../../contexts/AuthContext"
import { ValidationInstructions } from "@/components/validation-instructions"

export default function ResetPasswordPage({ params }: { params: { uuid: string } }) {
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false)
  const [isValidating, setIsValidating] = useState(true)
  const [isValid, setIsValid] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const router = useRouter()
  const { theme } = useTheme()
  const { resetPassword, isLoading } = useAuth()

  // Check if the reset token is valid
  useEffect(() => {
    setIsValid(true)
    setIsValidating(false)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== passwordConfirm) {
      setIsError(true)
      setMessage("Passwords do not match.")
      return
    }

    setMessage("")
    setIsError(false)

    try {
      const result = await resetPassword(params.uuid, password, passwordConfirm)
      if (result.success) {
        setMessage(result.message)
        // Redirect to login page after 3 seconds
        setTimeout(() => router.push("/login"), 3000)
      } else {
        setIsError(true)
        setMessage(result.message)
      }
    } catch (error) {
      setIsError(true)
      setMessage("An error occurred. Please try again.")
    }
  }

  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword)
  }

  const togglePasswordConfirmVisibility = () => {
    setShowPasswordConfirm(!showPasswordConfirm)
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
          <h1 className="text-4xl text-center mb-12">reset your password</h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="password" className="sr-only">
                new password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white pr-10`}
                  placeholder="new password (8-32 characters)"
                  required
                  minLength={8}
                  maxLength={32}
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
              <ValidationInstructions value={password} type="password" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password-confirm" className="sr-only">
                confirm new password
              </Label>
              <div className="relative">
                <Input
                  id="password-confirm"
                  type={showPasswordConfirm ? "text" : "password"}
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white pr-10`}
                  placeholder="confirm new password"
                  required
                />
                <button
                  type="button"
                  className="absolute right-0 top-1/2 transform -translate-y-1/2 text-gray-500"
                  onClick={togglePasswordConfirmVisibility}
                  tabIndex={-1}
                >
                  {showPasswordConfirm ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {message && (
              <p className={`text-sm text-center ${isError ? "text-red-500" : "text-green-500"}`}>{message}</p>
            )}

            <Button
              type="submit"
              className={`w-full h-12 border ${theme === "dark" ? "border-white bg-transparent hover:bg-white hover:text-black" : "border-black bg-transparent hover:bg-black hover:text-white"} rounded-md transition-colors`}
              disabled={isLoading}
            >
              {isLoading ? "Resetting..." : "reset password"}
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}
