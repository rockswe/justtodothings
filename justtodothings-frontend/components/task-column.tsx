"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Plus, Check, Mail } from "lucide-react"
import { TaskForm } from "./task-form"
import { useTheme } from "../contexts/ThemeContext"
import { useTasks } from "../contexts/TaskContext"
import type { Task } from "@/services/api"
import { useDraggable, useDroppable } from "@dnd-kit/core"
import { EmailReplyCanvas } from "./email-reply-canvas"
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
}

function DraggableTaskCard({ task, onEdit, onToggleComplete, onHover, isHovered }: DraggableTaskCardProps) {
  const { theme } = useTheme()
  const { toast } = useToast()
  const { updateTask } = useTasks()
  const [isReplyCanvasOpen, setIsReplyCanvasOpen] = useState(false)
  const [currentDraft, setCurrentDraft] = useState<string>("")
  const [isLoadingDraft, setIsLoadingDraft] = useState(false)

  // Check if the task is eligible for email reply
  const isEmailReplyTask =
    task.source_metadata?.integration_type === "gmail" &&
    task.source_metadata?.action_type_hint === "email_reply_needed"

  // Check if the task has a draft
  const hasDraft = !!task.generated_draft

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

  // Initialize currentDraft when the task changes or when the reply canvas is opened
  useEffect(() => {
    if (task.generated_draft) {
      setCurrentDraft(task.generated_draft)
    }
  }, [task.generated_draft])

  const handleGenerateInitialDraft = async () => {
    try {
      setIsLoadingDraft(true)
      const updatedTask = await taskAPI.generateInitialDraft(task.id)
      setCurrentDraft(updatedTask.generated_draft || "")
      setIsReplyCanvasOpen(true)

      // Update the task in the context to reflect the new draft
      await updateTask(task.id, updatedTask)

      toast({
        title: "Draft Generated",
        description: "Email reply draft has been generated successfully.",
      })
    } catch (error) {
      console.error("Error generating draft:", error)
      toast({
        title: "Error",
        description: "Failed to generate email draft. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsLoadingDraft(false)
    }
  }

  const handleRewriteDraft = async (instructions: string) => {
    try {
      setIsLoadingDraft(true)
      const updatedTask = await taskAPI.rewriteEmailDraft(task.id, instructions)
      setCurrentDraft(updatedTask.generated_draft || "")

      // Update the task in the context to reflect the new draft
      await updateTask(task.id, updatedTask)

      toast({
        title: "Draft Rewritten",
        description: "Email reply draft has been rewritten successfully.",
      })
    } catch (error) {
      console.error("Error rewriting draft:", error)
      toast({
        title: "Error",
        description: "Failed to rewrite email draft. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsLoadingDraft(false)
    }
  }

  const handleSendEmail = async (emailBody: string) => {
    try {
      setIsLoadingDraft(true)
      await taskAPI.sendEmailReply(task.id, emailBody)

      // Mark the task as completed
      await updateTask(task.id, { is_completed: true })

      setIsReplyCanvasOpen(false)

      toast({
        title: "Email Sent",
        description: "Your email reply has been sent successfully.",
      })
    } catch (error) {
      console.error("Error sending email:", error)
      toast({
        title: "Error",
        description: "Failed to send email. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsLoadingDraft(false)
    }
  }

  return (
    <>
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

          {/* Email Reply Button for eligible tasks */}
          {isEmailReplyTask && !task.is_completed && (
            <Button
              variant="outline"
              size="sm"
              className={`mt-2 w-full ${theme === "dark" ? "border-white/20" : "border-black/20"}`}
              onClick={(e) => {
                e.stopPropagation() // Prevent opening the edit form
                if (hasDraft) {
                  setIsReplyCanvasOpen(true)
                } else {
                  handleGenerateInitialDraft()
                }
              }}
              disabled={isLoadingDraft}
            >
              <Mail className="h-4 w-4 mr-2" />
              {isLoadingDraft ? "Loading..." : hasDraft ? "Answer to Email?" : "Generate Email Draft?"}
            </Button>
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
        <EmailReplyCanvas
          task={task}
          initialDraft={currentDraft}
          onClose={() => setIsReplyCanvasOpen(false)}
          onRewrite={handleRewriteDraft}
          onSend={handleSendEmail}
          isLoading={isLoadingDraft}
        />
      )}
    </>
  )
}
