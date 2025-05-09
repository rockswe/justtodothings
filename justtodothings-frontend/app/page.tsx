"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { TaskColumn } from "@/components/task-column"
import { SettingsCard } from "@/components/settings-card"
import { Button } from "@/components/ui/button"
import { useTheme } from "../contexts/ThemeContext"
import { useAuth } from "../contexts/AuthContext"
import { useTasks } from "../contexts/TaskContext"
import { OpeningAnimation } from "@/components/opening-animation"

export default function TodoApp() {
  const [showSettings, setShowSettings] = useState(false)
  const { theme } = useTheme()
  const { isAuthenticated, logout, deleteAccount } = useAuth()
  const { tasks, deleteAllTasks, isLoading } = useTasks()
  const [showOpeningAnimation, setShowOpeningAnimation] = useState(true)

  useEffect(() => {
    const hasVisited = localStorage.getItem("hasVisited")
    if (hasVisited) {
      setShowOpeningAnimation(false)
    }
  }, [])

  const handleLogout = () => {
    logout()
  }

  const handleDeleteAllTodos = async () => {
    await deleteAllTasks()
  }

  const handleDeleteAccount = async () => {
    await deleteAccount()
  }

  const handleAnimationComplete = () => {
    setShowOpeningAnimation(false)
    localStorage.setItem("hasVisited", "true")
  }

  return (
    <div
      className={`min-h-screen ${theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"} font-mono flex flex-col items-center`}
    >
      {showOpeningAnimation ? (
        <OpeningAnimation onComplete={handleAnimationComplete} />
      ) : (
        <>
          <header className="w-full p-4 flex justify-between items-start">
            <Link href="/" className="text-2xl">
              justtodothings
            </Link>
            <nav className="space-y-2 text-right">
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
            </nav>
          </header>

          <main className="flex-1 w-full max-w-6xl px-4 py-12 relative">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-12 justify-items-center">
              <TaskColumn title="important" todos={tasks.filter((todo) => todo.priority === "important")} />
              <TaskColumn title="medium" todos={tasks.filter((todo) => todo.priority === "medium")} />
              <TaskColumn title="low" todos={tasks.filter((todo) => todo.priority === "low")} />
            </div>

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
          </main>

          <footer className={`w-full p-8 text-center text-sm ${theme === "dark" ? "text-white/60" : "text-black/60"}`}>
            {isAuthenticated
              ? "your tasks are securely stored in the cloud."
              : "(if you don't sign up, your data will be stored on your web cookies)"}
          </footer>
        </>
      )}
    </div>
  )
}
