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
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { Card } from "@/components/ui/card"
import type { Task } from "@/services/api"
import { useSearchParams, useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"

export default function TodoApp() {
  const [showSettings, setShowSettings] = useState(false)
  const [showOpeningAnimation, setShowOpeningAnimation] = useState(true)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()

  const { theme } = useTheme()
  const { isAuthenticated, logout, deleteAccount } = useAuth()
  const { tasks, updateTask, deleteAllTasks, isLoading } = useTasks()

  // Check for OAuth success parameter
  useEffect(() => {
    const oauthSuccess = searchParams.get("oauth_success")
    const error = searchParams.get("error")
    const app = searchParams.get("app")
    const status = searchParams.get("status")

    if (oauthSuccess === "true") {
      toast({
        title: "successfully signed in",
        description: "welcome to justtodothings!",
        duration: 5000,
      })

      // Remove the query parameter to prevent showing the toast on refresh
      const url = new URL(window.location.href)
      url.searchParams.delete("oauth_success")
      router.replace(url.pathname + url.search)
    } else if (error) {
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
        default:
          errorMessage = "Authentication failed. Please try again."
      }

      toast({
        title: "Sign in failed",
        description: errorMessage,
        variant: "destructive",
        duration: 5000,
      })

      // Remove the error parameter
      const url = new URL(window.location.href)
      url.searchParams.delete("error")
      router.replace(url.pathname + url.search)
    } else if (status === "success" && app && ["gmail", "github", "slack", "canvas"].includes(app)) {
      // Handle successful app connection
      toast({
        title: "Connected successfully",
        description: `Your ${app} account has been connected.`,
        duration: 5000,
      })

      // If settings are open, we'll let the SettingsCard handle the refresh
      // If not, we should trigger a refresh of user settings if they're stored globally

      // Remove the query parameters
      const url = new URL(window.location.href)
      url.searchParams.delete("app")
      url.searchParams.delete("status")
      router.replace(url.pathname + url.search)
    } else if (status === "error" && app) {
      // Handle app connection error
      const message = searchParams.get("message") || `Failed to connect to ${app}`

      toast({
        title: "Connection failed",
        description: message,
        variant: "destructive",
        duration: 5000,
      })

      // Remove the query parameters
      const url = new URL(window.location.href)
      url.searchParams.delete("app")
      url.searchParams.delete("status")
      url.searchParams.delete("message")
      router.replace(url.pathname + url.search)
    }
  }, [searchParams, toast, router])

  // Configure DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px of movement required before drag starts
      },
    }),
  )

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

  // Handle drag start
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event
    if (active.data.current?.type === "task") {
      setActiveTask(active.data.current.task)
    }
  }

  // Handle drag end
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    // Reset active task
    setActiveTask(null)

    // If no over target or same column, do nothing
    if (!over || !active.data.current || !over.data.current) return

    // If task was dropped on a column
    if (active.data.current.type === "task" && over.data.current.type === "column") {
      const task = active.data.current.task as Task
      const newPriority = over.data.current.priority as "low" | "medium" | "important"

      // If priority changed, update the task
      if (task.priority !== newPriority) {
        await updateTask(task.id, { priority: newPriority })
      }
    }
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
            <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-12 justify-items-center">
                <TaskColumn title="important" todos={tasks.filter((todo) => todo.priority === "important")} />
                <TaskColumn title="medium" todos={tasks.filter((todo) => todo.priority === "medium")} />
                <TaskColumn title="low" todos={tasks.filter((todo) => todo.priority === "low")} />
              </div>

              {/* Drag overlay to show what's being dragged */}
              <DragOverlay>
                {activeTask && (
                  <Card
                    className={`p-4 bg-transparent border ${
                      theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
                    } w-full max-w-sm opacity-80`}
                  >
                    <div className="space-y-2 break-words">
                      <h3 className={activeTask.is_completed ? "line-through opacity-70" : ""}>{activeTask.title}</h3>
                      <p
                        className={`text-sm ${theme === "dark" ? "text-white/60" : "text-black/60"} ${activeTask.is_completed ? "line-through opacity-70" : ""}`}
                      >
                        {activeTask.description}
                      </p>
                    </div>
                  </Card>
                )}
              </DragOverlay>
            </DndContext>

            {showSettings && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div className="w-full max-w-xl p-4">
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
