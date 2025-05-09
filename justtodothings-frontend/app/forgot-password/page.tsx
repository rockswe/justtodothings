"use client"

import type React from "react"

import Link from "next/link"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useTheme } from "../../contexts/ThemeContext"
import { useAuth } from "../../contexts/AuthContext"

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const { theme } = useTheme()
  const { forgotPassword, isLoading } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage("")
    setIsError(false)

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setIsError(true)
      setMessage("Please enter a valid email address (format: name@domain.com)")
      return
    }

    try {
      const result = await forgotPassword(email)
      if (result.success) {
        setMessage(result.message)
      } else {
        setIsError(true)
        setMessage(result.message)
      }
    } catch (error) {
      setIsError(true)
      setMessage("An error occurred. Please try again.")
    }
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
          <h1 className="text-4xl text-center mb-12">forgot my password</h1>

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
                  className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white`}
                  placeholder="email"
                  required
                  pattern="[^\s@]+@[^\s@]+\.[^\s@]+"
                  title="Please enter a valid email address (format: name@domain.com)"
                />
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
              {isLoading ? "Sending..." : "reset your password"}
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}
