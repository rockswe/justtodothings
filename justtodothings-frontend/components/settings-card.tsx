"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Plus, Check, Reply, Send, X, RefreshCw } from "lucide-react"
import { TaskForm } from "./task-form"
import { useTheme } from "../contexts/ThemeContext"
import { useTasks } from "../contexts/TaskContext"
import type { Task } from "@/services/api"
import { useDraggable, useDroppable } from "@dnd-kit/core"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { taskAPI } from "@/services/api"

interface TaskColumnProps {
  title: "low" | "medium" | "important"
  todos: Task[]
}

export function TaskColumn({ title, todos }: TaskColumnProps) {
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null)
  const [hoveredTaskId, setHoveredTaskId] = useState<number | null>(null)
  const { theme } = useTheme()
  const { createTask, updateTask, deleteTask } = useTasks()

  // Setup droppable area for this column
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: `column-${title}`,
    data: {
      type: "column",
      priority: title,
    },
  })

  const handleSubmit = async (task: {
    id?: number
    title: string
    description: string
    dueDate: string
    priority: "low" | "medium" | "important"
  }) => {
    if (editingTaskId !== null) {
      await updateTask(editingTaskId, {
        title: task.title,
        description: task.description,
        priority: title,
        due_date: task.dueDate,
      })
      setEditingTaskId(null)
    } else {
      await createTask({
        title: task.title,
        description: task.description,
        priority: title,
        due_date: task.dueDate,
      })
    }
    setIsFormOpen(false)
  }

  const handleDeleteTask = async (id: number) => {
    await deleteTask(id)
    setIsFormOpen(false)
    setEditingTaskId(null)
  }

  const handleToggleComplete = async (e: React.MouseEvent, task: Task) => {
    e.stopPropagation() // Prevent opening the edit form
    await updateTask(task.id, { is_completed: !task.is_completed })
  }

  return (
    <div className="space-y-4 w-full max-w-sm flex flex-col items-center">
      <div className="flex items-center justify-between mb-6 w-full">
        <h2 className="text-xl text-center w-full">{title}</h2>
        <Button
          variant="outline"
          size="icon"
          className={`border-white/20 bg-transparent ${theme === "dark" ? "text-white hover:bg-transparent" : "text-black hover:bg-gray-100"}`}
          onClick={() => {
            setEditingTaskId(null)
            setIsFormOpen(true)
          }}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div ref={setDroppableRef} className="w-full min-h-[200px] space-y-4">
        {todos.length === 0 && (
          <Card
            className={`p-4 bg-transparent border ${theme === "dark" ? "border-white/20 text-white/60" : "border-black/20 text-black/60"} w-full`}
          >
            *blank*
          </Card>
        )}

        {todos.map((task) => (
          <DraggableTaskCard
            key={task.id}
            task={task}
            onEdit={() => {
              setEditingTaskId(task.id)
              setIsFormOpen(true)
            }}
            onToggleComplete={(e) => handleToggleComplete(e, task)}
            onHover={(isHovered) => setHoveredTaskId(isHovered ? task.id : null)}
            isHovered={hoveredTaskId === task.id}
            updateTask={updateTask}
          />
        ))}
      </div>

      {isFormOpen && (
        <TaskForm
          onClose={() => {
            setIsFormOpen(false)
            setEditingTaskId(null)
          }}
          onSubmit={handleSubmit}
          onDelete={handleDeleteTask}
          editTask={editingTaskId !== null ? todos.find((t) => t.id === editingTaskId) : undefined}
          priority={title}
        />
      )}
    </div>
  )
}

interface DraggableTaskCardProps {
  task: Task
  onEdit: () => void
  onToggleComplete: (e: React.MouseEvent) => void
  onHover: (isHovered: boolean) => void
  isHovered: boolean
  updateTask?: (taskId: number, updates: Partial<Task>) => Promise<Task | null>
}

function DraggableTaskCard({ task, onEdit, onToggleComplete, onHover, isHovered, updateTask }: DraggableTaskCardProps) {
  const { theme } = useTheme()
  const { toast } = useToast()

  // Add state for email reply functionality
  const [isReplyCanvasOpen, setIsReplyCanvasOpen] = useState(false)
  const [currentDraft, setCurrentDraft] = useState("")
  const [rewritePromptVisible, setRewritePromptVisible] = useState(false)
  const [rewriteInstructions, setRewriteInstructions] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  // Setup draggable for this task card
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: `task-${task.id}`,
    data: {
      type: "task",
      task,
    },
  })

  // Initialize currentDraft when task.generated_draft changes
  useEffect(() => {
    if (task.generated_draft) {
      setCurrentDraft(task.generated_draft)
    }
  }, [task.generated_draft])

  // Check if the task is eligible for email reply
  const isEmailReplyEligible =
    task.source_metadata?.integration_type === "gmail" &&
    task.source_metadata?.action_type_hint === "email_reply_needed" &&
    task.generated_draft &&
    task.generated_draft.trim() !== ""

  // Handle rewrite draft
  const handleRewriteDraft = async () => {
    if (!rewriteInstructions.trim() || !updateTask) return

    setIsLoading(true)
    try {
      const result = await taskAPI.rewriteEmailDraft(task.id, rewriteInstructions)
      if (result) {
        setCurrentDraft(result.generated_draft || "")
        setRewriteInstructions("")
        setRewritePromptVisible(false)

        // Update the task in context
        if (updateTask) {
          await updateTask(task.id, { generated_draft: result.generated_draft })
        }

        toast({
          title: "Draft rewritten",
          description: "Your email draft has been updated based on your instructions.",
        })
      }
    } catch (error) {
      console.error("Error rewriting draft:", error)
      toast({
        title: "Error",
        description: "Failed to rewrite the draft. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  // Handle send email
  const handleSendEmail = async () => {
    if (!currentDraft.trim()) return

    setIsLoading(true)
    try {
      const result = await taskAPI.sendEmailReply(task.id, currentDraft)

      toast({
        title: "Email sent",
        description: result.message || "Your email has been sent successfully.",
      })

      setIsReplyCanvasOpen(false)

      // Optimistically update the task as completed
      if (updateTask) {
        await updateTask(task.id, { is_completed: true })
      }
    } catch (error) {
      console.error("Error sending email:", error)
      toast({
        title: "Error",
        description: "Failed to send the email. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  // Handle generate initial draft (if needed)
  const handleGenerateInitialDraft = async () => {
    setIsLoading(true)
    try {
      const result = await taskAPI.generateInitialDraft(task.id)
      if (result) {
        setCurrentDraft(result.generated_draft || "")

        // Update the task in context
        if (updateTask) {
          await updateTask(task.id, { generated_draft: result.generated_draft })
        }

        toast({
          title: "Draft generated",
          description: "An email draft has been generated for you.",
        })
      }
    } catch (error) {
      console.error("Error generating draft:", error)
      toast({
        title: "Error",
        description: "Failed to generate a draft. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="w-full">
      <Card
        ref={setDraggableRef}
        {...listeners}
        {...attributes}
        className={`p-4 bg-transparent border ${
          theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
        } cursor-grab hover:bg-transparent w-full relative group ${isDragging ? "opacity-50" : ""}`}
        onClick={onEdit}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
      >
        <div className="space-y-2 break-words">
          <h3 className={task.is_completed ? "line-through opacity-70" : ""}>{task.title}</h3>
          <p
            className={`text-sm ${theme === "dark" ? "text-white/60" : "text-black/60"} ${task.is_completed ? "line-through opacity-70" : ""}`}
          >
            {task.description}
          </p>
          <p
            className={`text-xs ${theme === "dark" ? "text-white/40" : "text-black/40"} ${task.is_completed ? "line-through opacity-70" : ""}`}
          >
            {task.due_date
              ? new Date(task.due_date).toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : ""}
          </p>

          {/* Email Reply Button */}
          {isEmailReplyEligible && (
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                className={`w-full flex items-center justify-center gap-1 ${
                  theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  setIsReplyCanvasOpen(!isReplyCanvasOpen)
                }}
              >
                <Reply className="h-3 w-3" />
                <span>Answer to Email?</span>
              </Button>
            </div>
          )}
        </div>

        {/* Completion button that appears on hover */}
        <Button
          variant="ghost"
          size="icon"
          className={`absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 p-1 ${
            task.is_completed
              ? theme === "dark"
                ? "bg-white/20 text-white hover:bg-white/10"
                : "bg-black/20 text-black hover:bg-black/10"
              : "hover:bg-transparent"
          }`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleComplete(e)
          }}
        >
          <Check className={`h-4 w-4 ${task.is_completed ? "opacity-100" : "opacity-50"}`} />
          <span className="sr-only">{task.is_completed ? "Mark as incomplete" : "Mark as complete"}</span>
        </Button>
      </Card>

      {/* Email Reply Canvas */}
      {isReplyCanvasOpen && (
        <Card
          className={`mt-2 p-4 bg-transparent border ${
            theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
          } w-full`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h4 className="text-sm font-medium">AI-Generated Email Draft</h4>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsReplyCanvasOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <Textarea
              value={currentDraft}
              onChange={(e) => setCurrentDraft(e.target.value)}
              className={`min-h-[150px] bg-transparent border ${
                theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
              } rounded-md p-2 text-sm`}
              placeholder="Email draft will appear here..."
              disabled={isLoading}
            />

            <div className="flex flex-wrap gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                className={`${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"}`}
                onClick={() => setIsReplyCanvasOpen(false)}
                disabled={isLoading}
              >
                reject
              </Button>

              <Button
                variant="outline"
                size="sm"
                className={`${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"}`}
                onClick={() => setRewritePromptVisible(true)}
                disabled={isLoading}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                rewrite draft?
              </Button>

              <Button
                variant="outline"
                size="sm"
                className={`${
                  theme === "dark" ? "bg-white text-black hover:bg-white/90" : "bg-black text-white hover:bg-black/90"
                }`}
                onClick={handleSendEmail}
                disabled={isLoading || !currentDraft.trim()}
              >
                <Send className="h-3 w-3 mr-1" />
                send
              </Button>
            </div>

            {/* Rewrite Prompt */}
            {rewritePromptVisible && (
              <div className={`mt-4 p-3 rounded-md ${theme === "dark" ? "bg-white/5" : "bg-black/5"}`}>
                <h5 className="text-sm font-medium mb-2">How would you like to improve this draft?</h5>
                <Textarea
                  value={rewriteInstructions}
                  onChange={(e) => setRewriteInstructions(e.target.value)}
                  className={`min-h-[80px] bg-transparent border ${
                    theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
                  } rounded-md p-2 text-sm mb-3`}
                  placeholder="e.g., Make it more formal, add more details about..."
                  disabled={isLoading}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className={`${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"}`}
                    onClick={() => {
                      setRewritePromptVisible(false)
                      setRewriteInstructions("")
                    }}
                    disabled={isLoading}
                  >
                    cancel
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`${
                      theme === "dark"
                        ? "bg-white text-black hover:bg-white/90"
                        : "bg-black text-white hover:bg-black/90"
                    }`}
                    onClick={handleRewriteDraft}
                    disabled={isLoading || !rewriteInstructions.trim()}
                  >
                    submit rewrite
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
