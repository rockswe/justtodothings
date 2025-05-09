"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"
import { taskAPI, type Task, type CreateTaskPayload, type UpdateTaskPayload } from "@/services/api"
import { useAuth } from "./AuthContext"

interface TaskContextType {
  tasks: Task[]
  isLoading: boolean
  error: string | null
  createTask: (task: CreateTaskPayload) => Promise<Task | null>
  updateTask: (taskId: number, task: UpdateTaskPayload) => Promise<Task | null>
  deleteTask: (taskId: number) => Promise<boolean>
  deleteAllTasks: () => Promise<boolean>
  fetchTasks: () => Promise<void>
}

const TaskContext = createContext<TaskContextType | undefined>(undefined)

// Example tasks for first-time visitors
const exampleTasks: Task[] = [
  {
    id: 1001,
    title: "Calculus 1 Midterm",
    description:
      "Review Module 4 \"Indeterminate Limits and L'Hôpital's Rule\", the study guide, and practice book problems for the midterm.",
    priority: "important",
    due_date: new Date("2025-02-25T12:00:00").toISOString(),
    todo_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_completed: false,
  },
  {
    id: 1002,
    title: "Grocery Shopping",
    description: "Buy essentials like milk, eggs, and vegetables for the week.",
    priority: "important",
    due_date: new Date("2025-02-16T12:00:00").toISOString(),
    todo_order: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_completed: false,
  },
  {
    id: 1003,
    title: "Apply for Summer Internships",
    description: "Complete the applications for the LinkedIn internship job postings.",
    priority: "medium",
    due_date: new Date("2025-03-15T12:00:00").toISOString(),
    todo_order: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_completed: false,
  },
  {
    id: 1004,
    title: "Clean Workspace",
    description: "Organize desk and clean up clutter for better productivity.",
    priority: "low",
    due_date: new Date("2025-02-16T12:00:00").toISOString(),
    todo_order: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_completed: false,
  },
]

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const { isAuthenticated } = useAuth()

  const fetchTasks = async () => {
    if (!isAuthenticated) return

    setIsLoading(true)
    setError(null)
    try {
      const fetchedTasks = await taskAPI.getTasks()
      setTasks(fetchedTasks)
    } catch (err: any) {
      console.error("Error fetching tasks:", err)
      setError(err.response?.data?.message || "Failed to fetch tasks")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (isAuthenticated) {
      fetchTasks()
    } else {
      // If not authenticated, we'll use local storage tasks
      const storedTasks = localStorage.getItem("tasks")
      const hasVisitedBefore = localStorage.getItem("hasVisitedBefore") === "true"

      if (storedTasks) {
        // If there are tasks in localStorage, use them
        setTasks(JSON.parse(storedTasks))
      } else if (!hasVisitedBefore) {
        // Only for first-time visitors who haven't visited before
        setTasks(exampleTasks)
        localStorage.setItem("tasks", JSON.stringify(exampleTasks))
        localStorage.setItem("hasVisitedBefore", "true")
      } else {
        // User has visited before but has no tasks (likely deleted them all)
        setTasks([])
      }
    }
  }, [isAuthenticated])

  // Save tasks to localStorage when they change (for non-authenticated users)
  useEffect(() => {
    if (!isAuthenticated) {
      localStorage.setItem("tasks", JSON.stringify(tasks))
    }
  }, [tasks, isAuthenticated])

  const createTask = async (taskData: CreateTaskPayload): Promise<Task | null> => {
    setIsLoading(true)
    setError(null)
    try {
      if (isAuthenticated) {
        // Create task on the server
        const newTask = await taskAPI.createTask(taskData)
        setTasks((prevTasks) => [...prevTasks, newTask])
        return newTask
      } else {
        // Create task locally
        const newTask: Task = {
          id: Date.now(),
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          due_date: taskData.due_date,
          todo_order: tasks.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          is_completed: taskData.is_completed || false,
        }
        setTasks((prevTasks) => [...prevTasks, newTask])
        return newTask
      }
    } catch (err: any) {
      console.error("Error creating task:", err)
      setError(err.response?.data?.message || "Failed to create task")
      return null
    } finally {
      setIsLoading(false)
    }
  }

  const updateTask = async (taskId: number, taskData: UpdateTaskPayload): Promise<Task | null> => {
    setIsLoading(true)
    setError(null)
    try {
      if (isAuthenticated) {
        // Update task on the server
        const updatedTask = await taskAPI.updateTask(taskId, taskData)
        setTasks((prevTasks) => prevTasks.map((task) => (task.id === taskId ? updatedTask : task)))
        return updatedTask
      } else {
        // Update task locally
        const updatedTask = tasks.find((task) => task.id === taskId)
        if (!updatedTask) {
          throw new Error("Task not found")
        }
        const newUpdatedTask: Task = {
          ...updatedTask,
          ...taskData,
          updated_at: new Date().toISOString(),
        }
        setTasks((prevTasks) => prevTasks.map((task) => (task.id === taskId ? newUpdatedTask : task)))
        return newUpdatedTask
      }
    } catch (err: any) {
      console.error("Error updating task:", err)
      setError(err.response?.data?.message || "Failed to update task")
      return null
    } finally {
      setIsLoading(false)
    }
  }

  const deleteTask = async (taskId: number): Promise<boolean> => {
    setIsLoading(true)
    setError(null)
    try {
      if (isAuthenticated) {
        // Delete task on the server
        await taskAPI.deleteTask(taskId)
      }
      // Always remove from local state
      setTasks((prevTasks) => prevTasks.filter((task) => task.id !== taskId))
      return true
    } catch (err: any) {
      console.error("Error deleting task:", err)
      setError(err.response?.data?.message || "Failed to delete task")
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const deleteAllTasks = async (): Promise<boolean> => {
    setIsLoading(true)
    setError(null)
    try {
      if (isAuthenticated) {
        // Delete all tasks on the server
        await taskAPI.deleteAllTasks()
      }
      // Always clear local state
      setTasks([])
      // Make sure we update localStorage to reflect the empty tasks
      localStorage.setItem("tasks", JSON.stringify([]))
      return true
    } catch (err: any) {
      console.error("Error deleting all tasks:", err)
      setError(err.response?.data?.message || "Failed to delete all tasks")
      return false
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <TaskContext.Provider
      value={{
        tasks,
        isLoading,
        error,
        createTask,
        updateTask,
        deleteTask,
        deleteAllTasks,
        fetchTasks,
      }}
    >
      {children}
    </TaskContext.Provider>
  )
}

export function useTasks() {
  const context = useContext(TaskContext)
  if (context === undefined) {
    throw new Error("useTasks must be used within a TaskProvider")
  }
  return context
}
