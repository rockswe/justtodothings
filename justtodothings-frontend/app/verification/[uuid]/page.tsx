"use client"

import { Button } from "@/components/ui/button"

import { useState, useEffect } from "react"
import Link from "next/link"
import { motion } from "framer-motion"
import { CheckCircleIcon, XCircleIcon, MailIcon } from "lucide-react"
import { useTheme } from "../../../contexts/ThemeContext"
import { authAPI } from "@/services/api"

export default function VerificationPage({ params }: { params: { uuid: string } }) {
  const [countdown, setCountdown] = useState(5)
  const [isVerifying, setIsVerifying] = useState(true)
  const [isVerified, setIsVerified] = useState(false)
  const [isExpired, setIsExpired] = useState(false)
  const [isAlreadyUsed, setIsAlreadyUsed] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const { theme } = useTheme()

  useEffect(() => {
    const verifyEmail = async () => {
      try {
        await authAPI.verifyEmail(params.uuid)
        setIsVerified(true)
        setIsVerifying(false)
      } catch (error: any) {
        setIsVerified(false)
        setIsVerifying(false)

        const errorMsg = error.response?.data?.message || "Verification failed. Please try again."
        setErrorMessage(errorMsg)

        // Check for specific error messages
        if (errorMsg.includes("expired")) {
          setIsExpired(true)
        } else if (errorMsg.includes("already been used")) {
          setIsAlreadyUsed(true)
        }
      }
    }

    verifyEmail()
  }, [params.uuid])

  useEffect(() => {
    if (isVerified) {
      const timer = setInterval(() => {
        setCountdown((prev) => (prev > 0 ? prev - 1 : 0))
      }, 1000)

      return () => clearInterval(timer)
    }
  }, [isVerified])

  useEffect(() => {
    if (countdown === 0 && isVerified) {
      window.location.href = "/login"
    }
  }, [countdown, isVerified])

  return (
    <div
      className={`min-h-screen ${
        theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"
      } font-mono flex flex-col`}
    >
      <header className="w-full p-4 flex justify-between items-start">
        <Link href="/" className="text-2xl">
          justtodothings
        </Link>
        <nav className="space-y-2 text-right">
          <Link href="/login" className="block hover:underline">
            login
          </Link>
          <Link href="/signup" className="block hover:underline">
            sign up
          </Link>
          <Link href="/contact" className="block hover:underline">
            contact
          </Link>
        </nav>
      </header>

      <main className="flex-grow flex items-center justify-center px-4">
        {isVerifying ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <p className="text-xl mb-4">verifying your email...</p>
          </motion.div>
        ) : isVerified ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 260, damping: 20 }}
            >
              <CheckCircleIcon className="w-24 h-24 mx-auto mb-6 text-green-500" />
            </motion.div>
            <h1 className="text-4xl mb-4">email verified!</h1>
            <p className={`text-lg mb-6 ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>
              your account has been successfully verified.
            </p>
            <p className={`text-sm mb-8 ${theme === "dark" ? "text-gray-400" : "text-gray-500"}`}>
              redirecting to login page in {countdown} seconds...
            </p>
          </motion.div>
        ) : isExpired ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 260, damping: 20 }}
            >
              <MailIcon className="w-24 h-24 mx-auto mb-6 text-blue-500" />
            </motion.div>
            <h1 className="text-4xl mb-4">verification link expired</h1>
            <p className={`text-lg mb-6 ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>{errorMessage}</p>
            <p className={`text-md mb-8 ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>
              Please check your email for the new verification link.
            </p>
            <Link href="/login">
              <Button variant="outline">go to login</Button>
            </Link>
          </motion.div>
        ) : isAlreadyUsed ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 260, damping: 20 }}
            >
              <CheckCircleIcon className="w-24 h-24 mx-auto mb-6 text-green-500" />
            </motion.div>
            <h1 className="text-4xl mb-4">already verified</h1>
            <p className={`text-lg mb-6 ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>{errorMessage}</p>
            <p className={`text-md mb-8 ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>
              Your account has already been verified. You can now log in.
            </p>
            <Link href="/login">
              <Button variant="outline">go to login</Button>
            </Link>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 260, damping: 20 }}
            >
              <XCircleIcon className="w-24 h-24 mx-auto mb-6 text-red-500" />
            </motion.div>
            <h1 className="text-4xl mb-4">verification failed</h1>
            <p className={`text-lg mb-6 ${theme === "dark" ? "text-gray-300" : "text-gray-600"}`}>{errorMessage}</p>
            <Link href="/login">
              <Button variant="outline">go to login</Button>
            </Link>
          </motion.div>
        )}
      </main>

      <footer className={`w-full p-8 text-center text-sm ${theme === "dark" ? "text-white/60" : "text-black/60"}`}>
        &copy; {new Date().getFullYear()} justtodothings. All rights reserved.
      </footer>
    </div>
  )
}
