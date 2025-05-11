"use client"

import type React from "react"

import Link from "next/link"
import { useState, useEffect } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Github, Mail, Eye, EyeOff } from "lucide-react"
import { useTheme } from "../../contexts/ThemeContext"
import { ValidationInstructions } from "@/components/validation-instructions"
import { useAuth } from "../../contexts/AuthContext"
import { useRouter } from "next/navigation"

export default function SignupPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [passwordValid, setPasswordValid] = useState(false)
  const [passwordMatch, setPasswordMatch] = useState(false)
  const [emailExists, setEmailExists] = useState(false)
  const [isCheckingEmail, setIsCheckingEmail] = useState(false)
  const [formTouched, setFormTouched] = useState(false)
  const [signupError, setSignupError] = useState("")
  const [signupSuccess, setSignupSuccess] = useState("")
  const { theme } = useTheme()
  const { signup, isLoading } = useAuth()
  const router = useRouter()

  // Check if password meets complexity requirements
  const isPasswordValid = (password: string): boolean => {
    const minLength = password.length >= 8
    const hasUppercase = /[A-Z]/.test(password)
    const hasLowercase = /[a-z]/.test(password)
    const hasNumber = /\d/.test(password)
    const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)

    return minLength && hasUppercase && hasLowercase && hasNumber && hasSpecial
  }

  // Check if email is valid
  const isEmailValid = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  useEffect(() => {
    setPasswordValid(isPasswordValid(password))
    setPasswordMatch(password === passwordConfirm && password !== "")
  }, [password, passwordConfirm])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormTouched(true)
    setSignupError("")
    setSignupSuccess("")

    // Validate email format
    if (!isEmailValid(email)) {
      setSignupError("Please enter a valid email address (format: name@domain.com)")
      return
    }

    if (!passwordValid || !passwordMatch || !termsAccepted) {
      return
    }

    try {
      const result = await signup(email, password, passwordConfirm)
      if (result.success) {
        setSignupSuccess(result.message)
        // Redirect to login page after 3 seconds
        setTimeout(() => router.push("/login"), 3000)
      } else {
        setSignupError(result.message)
      }
    } catch (error) {
      setSignupError("An error occurred. Please try again.")
    }
  }

  const handleGithubSignup = () => {
    window.location.href = `${process.env.NEXT_PUBLIC_API_URL}/auth/github`
  }

  const handleGoogleSignup = () => {
    window.location.href = `${process.env.NEXT_PUBLIC_API_URL}/auth/google`
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
          <h1 className="text-4xl text-center mb-12">sign up</h1>

          {signupSuccess ? (
            <div className="text-center space-y-4">
              <p className="text-green-500">{signupSuccess}</p>
              <p>Redirecting to login page...</p>
            </div>
          ) : (
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
                <ValidationInstructions value={email} type="email" />
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
                    className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white pr-10`}
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
                <ValidationInstructions value={password} type="password" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password-confirm" className="sr-only">
                  password again
                </Label>
                <div className="relative">
                  <Input
                    id="password-confirm"
                    type={showPasswordConfirm ? "text" : "password"}
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    className={`bg-transparent border-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} rounded-none px-0 h-12 focus-visible:ring-0 focus-visible:border-white pr-10`}
                    placeholder="password again"
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

              {!passwordMatch && passwordConfirm && <p className="text-red-500 text-sm">Passwords do not match.</p>}

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="terms"
                  checked={termsAccepted}
                  onCheckedChange={(checked) => setTermsAccepted(checked as boolean)}
                  className={`border ${
                    theme === "dark"
                      ? "border-white data-[state=checked]:bg-white data-[state=checked]:text-black"
                      : "border-black data-[state=checked]:bg-black data-[state=checked]:text-white"
                  }`}
                  required
                />
                <label
                  htmlFor="terms"
                  className={`text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 ${
                    theme === "dark" ? "text-white" : "text-black"
                  }`}
                >
                  i&apos;ve read and accept the{" "}
                  <Link href="/termsandconditions" className="underline">
                    terms and conditions
                  </Link>
                </label>
              </div>

              {signupError && <p className="text-red-500 text-sm text-center">{signupError}</p>}

              <Button
                type="submit"
                variant="outline"
                className="w-full"
                disabled={isLoading || !termsAccepted || (formTouched && (!passwordValid || !passwordMatch))}
              >
                {isLoading ? "creating account..." : "create my account"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full flex items-center justify-center gap-2"
                onClick={handleGithubSignup}
              >
                <Github className="w-5 h-5" />
                sign up with github
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full flex items-center justify-center gap-2"
                onClick={handleGoogleSignup}
              >
                <Mail className="w-5 h-5" />
                sign up with google
              </Button>
            </form>
          )}

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
