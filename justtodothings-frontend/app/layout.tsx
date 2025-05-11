import type React from "react"
import { ThemeProvider } from "../contexts/ThemeContext"
import { AuthProvider } from "../contexts/AuthContext"
import { TaskProvider } from "../contexts/TaskContext"
import { Toaster } from "@/components/ui/toaster"
import "../styles/globals.css"
import type { Metadata } from "next"
import { Inter } from "next/font/google"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "justtodothings",
  description: "Manage your tasks AI-driven.",
    generator: 'v0.dev'
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <ThemeProvider>
            <TaskProvider>{children}</TaskProvider>
          </ThemeProvider>
        </AuthProvider>
        <Toaster />
      </body>
    </html>
  )
}
