"use client"

import type React from "react"

import Link from "next/link"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useTheme } from "../../contexts/ThemeContext"
import { ValidationInstructions } from "@/components/validation-instructions"
import { contactAPI } from "@/services/api"
import { useAuth } from "../../contexts/AuthContext"
import { SettingsCard } from "@/components/settings-card"
import { useTasks } from "../../contexts/TaskContext"

export default function ContactPage() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [formTouched, setFormTouched] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitSuccess, setSubmitSuccess] = useState<boolean | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const { theme } = useTheme()
  const { isAuthenticated, logout, deleteAccount } = useAuth()
  const { deleteAllTasks } = useTasks()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormTouched(true)

    // Validate form
    const isNameValid = name.trim().length > 0 && name.length <= 100
    const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    const isMessageValid = message.trim().length > 0 && message.length <= 2000

    if (!isNameValid) {
      setErrorMessage("Name is required and must be less than 100 characters")
      return
    }

    if (!isEmailValid) {
      setErrorMessage("Please enter a valid email address (format: name@domain.com)")
      return
    }

    if (!isMessageValid) {
      setErrorMessage("Message is required and must be less than 2000 characters")
      return
    }

    // Submit form
    setIsSubmitting(true)
    setErrorMessage("")

    try {
      const response = await contactAPI.sendMessage(name, email, message)
      setSubmitSuccess(true)
      // Reset form after successful submission
      setName("")
      setEmail("")
      setMessage("")
      setFormTouched(false)
    } catch (error: any) {
      setSubmitSuccess(false)
      setErrorMessage(error.response?.data?.message || "Failed to send message. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLogout = () => {
    logout()
  }

  const handleDeleteAllTodos = async () => {
    await deleteAllTasks()
  }

  const handleDeleteAccount = async () => {
    await deleteAccount()
  }

  return (
    <div className={`min-h-screen ${theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"} font-mono`}>
      <header className="w-full p-4 flex justify-between items-start">
        <Link href="/" className="text-2xl">
          justtodothings
        </Link>
        <div className="space-y-2 text-right">
          {!isAuthenticated && (
            <>
              <Link href="/login" className="block hover:underline">
                login
              </Link>
              <Link href="/signup" className="block hover:underline">
                sign up
              </Link>
            </>
          )}
          <Button
            variant="ghost"
            className="w-full text-right p-0 h-auto font-normal text-base hover:bg-transparent hover:underline"
            onClick={() => setShowSettings(true)}
          >
            settings
          </Button>
          <Link href="/contact" className="block hover:underline">
            contact
          </Link>
        </div>
      </header>

      <main className="flex flex-col items-center justify-center px-4 pt-20">
        <div className="w-full max-w-md space-y-8">
          <h1 className="text-4xl text-center mb-12">contact</h1>

          {submitSuccess ? (
            <div className="text-center space-y-4">
              <p className="text-green-500">Your message has been sent successfully!</p>
              <Button variant="outline" className="mt-4" onClick={() => setSubmitSuccess(null)}>
                send another message
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="name" className="sr-only">
                  name
                </Label>
                <div className="relative">
                  <Input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white`}
                    placeholder="name"
                    required
                  />
                </div>
                <ValidationInstructions value={name} type="name" />
              </div>

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
                <ValidationInstructions value={email} type="email" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="message" className="sr-only">
                  message
                </Label>
                <Textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className={`min-h-[150px] bg-transparent border ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-md p-4 focus-visible:ring-0 focus-visible:border-white resize-none`}
                  placeholder="your message"
                  required
                />
                <ValidationInstructions value={message} type="message" />
              </div>

              {errorMessage && <p className="text-red-500 text-sm text-center">{errorMessage}</p>}

              <Button type="submit" variant="outline" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "sending..." : "send message"}
              </Button>
            </form>
          )}

          <div className={`text-center text-sm ${theme === "dark" ? "text-white/60" : "text-black/60"}`}>
            <p>we&apos;ll get back to you as soon as possible</p>
          </div>
        </div>
      </main>

      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="w-full max-w-md p-4">
            <SettingsCard
              onClose={() => setShowSettings(false)}
              onLogout={handleLogout}
              onDeleteAllTodos={handleDeleteAllTodos}
              onDeleteAccount={handleDeleteAccount}
              isSignedUp={isAuthenticated}
            />
          </div>
        </div>
      )}
    </div>
  )
}
