"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Plus, Check } from "lucide-react"
import { TaskForm } from "./task-form"
import { useTheme } from "../contexts/ThemeContext"
import { useTasks } from "../contexts/TaskContext"
import type { Task } from "@/services/api"
import { useDraggable, useDroppable } from "@dnd-kit/core"

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

  return (
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
  )
}
