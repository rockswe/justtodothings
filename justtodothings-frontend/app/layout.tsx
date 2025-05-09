import type React from "react"
import { ThemeProvider } from "../contexts/ThemeContext"
import { AuthProvider } from "../contexts/AuthContext"
import { TaskProvider } from "../contexts/TaskContext"
import { Toaster } from "sonner"
import "../styles/globals.css"
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Just To Do Things',
  description: 'Manage your tasks efficiently.',
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
            <TaskProvider>
              {children}
              <Toaster richColors />
            </TaskProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
