"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Trash2, X } from "lucide-react"
import { useTheme } from "../contexts/ThemeContext"
import type { Task } from "@/services/api"

interface TaskFormProps {
  onSubmit: (task: {
    id?: number
    title: string
    description: string
    dueDate: string
    priority: "low" | "medium" | "important"
  }) => void
  onClose: () => void
  onDelete?: (id: number) => void
  editTask?: Task
  priority: "low" | "medium" | "important"
}

export function TaskForm({ onSubmit, onClose, onDelete, editTask, priority }: TaskFormProps) {
  const [title, setTitle] = useState(editTask?.title || "")
  const [description, setDescription] = useState(editTask?.description || "")
  const [day, setDay] = useState("")
  const [month, setMonth] = useState("")
  const [year, setYear] = useState("")
  const [hour, setHour] = useState("")
  const [minute, setMinute] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formTouched, setFormTouched] = useState(false)
  const { theme } = useTheme()

  useEffect(() => {
    if (editTask) {
      setTitle(editTask.title)
      setDescription(editTask.description)

      // Parse the date string from the API format
      if (editTask.due_date) {
        const dueDate = new Date(editTask.due_date)
        setDay(dueDate.getDate().toString())
        setMonth(dueDate.toLocaleString("default", { month: "long" }))
        setYear(dueDate.getFullYear().toString())
        setHour(dueDate.getHours().toString().padStart(2, "0"))
        setMinute(dueDate.getMinutes().toString().padStart(2, "0"))
      } else {
        // Set default date if no due date
        const now = new Date()
        setDay(now.getDate().toString())
        setMonth(now.toLocaleString("default", { month: "long" }))
        setYear(now.getFullYear().toString())
        setHour("12")
        setMinute("00")
      }
    } else {
      const now = new Date()
      setDay(now.getDate().toString())
      setMonth(now.toLocaleString("default", { month: "long" }))
      setYear(now.getFullYear().toString())
      setHour("12")
      setMinute("00")
    }
  }, [editTask])

  const days = Array.from({ length: 31 }, (_, i) => i + 1)
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() + i)
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const minutes = Array.from({ length: 60 }, (_, i) => i)

  const validateForm = () => {
    const newErrors: Record<string, string> = {}

    // Title validation (required, min 1 char, max 255 chars)
    if (!title.trim()) {
      newErrors.title = "Title is required."
    } else if (title.length > 255) {
      newErrors.title = "Title must be less than 255 characters."
    }

    // Description validation (optional, max 1000 chars)
    if (description.length > 1000) {
      newErrors.description = "Description must be less than 1000 characters."
    }

    // Date validation
    if (!day || !month || !year || !hour || !minute) {
      newErrors.date = "Please select a valid date and time."
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = () => {
    setFormTouched(true)

    if (!validateForm()) {
      return
    }

    // Format the date for the API (ISO format)
    const dueDate = new Date(`${month} ${day}, ${year} ${hour}:${minute}:00`).toISOString()

    const task = {
      title,
      description,
      dueDate,
      priority,
      ...(editTask && { id: editTask.id }),
      ...(editTask && { is_completed: editTask.is_completed }), // Preserve is_completed state when editing
    }

    onSubmit(task)
    onClose()
  }

  return (
    <Card
      className={`fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full max-w-md ${theme === "dark" ? "bg-[#1a1a1a] border-white/20 text-white" : "bg-white border-black/20 text-black"} p-8 space-y-6 z-50`}
    >
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg break-words max-w-[80%]">{editTask ? "edit task" : "add task"}</h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={`${theme === "dark" ? "text-white hover:bg-white/10" : "text-black hover:bg-black/10"}`}
            onClick={onClose}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </Button>
          {editTask && onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-500 hover:text-red-400 hover:bg-transparent"
              onClick={() => {
                onDelete(editTask.id)
                onClose()
              }}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={`${theme === "dark" ? "text-white hover:bg-white/10" : "text-black hover:bg-black/10"}`}
            onClick={handleSubmit}
          >
            done
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="space-y-2">
          <Label className={`${theme === "dark" ? "text-white/80" : "text-black/80"} text-center block w-full`}>
            title
          </Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} focus-visible:ring-0 focus-visible:ring-offset-0 ${
              errors.title ? "border-red-500" : ""
            }`}
            placeholder="task title"
            maxLength={255}
          />
          {errors.title && <p className="text-red-500 text-xs mt-1">{errors.title}</p>}
        </div>

        <div className="space-y-2">
          <Label className={`${theme === "dark" ? "text-white/80" : "text-black/80"} text-center block w-full`}>
            description
          </Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} focus-visible:ring-0 focus-visible:ring-offset-0 ${
              errors.description ? "border-red-500" : ""
            }`}
            placeholder="task description (optional)"
            maxLength={1000}
          />
          {errors.description && <p className="text-red-500 text-xs mt-1">{errors.description}</p>}
        </div>

        <div className="space-y-2">
          <Label className={`${theme === "dark" ? "text-white/80" : "text-black/80"} text-center block w-full`}>
            due date
          </Label>
          <div className="flex flex-wrap gap-2 items-center justify-center">
            <Select value={day} onValueChange={setDay}>
              <SelectTrigger
                className={`w-16 bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} ${
                  errors.date ? "border-red-500" : ""
                }`}
              >
                <SelectValue placeholder="1-31" />
              </SelectTrigger>
              <SelectContent>
                {days.map((d) => (
                  <SelectItem key={d} value={d.toString()}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger
                className={`w-32 bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} ${
                  errors.date ? "border-red-500" : ""
                }`}
              >
                <SelectValue placeholder="month" />
              </SelectTrigger>
              <SelectContent>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={year} onValueChange={setYear}>
              <SelectTrigger
                className={`w-20 bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} ${
                  errors.date ? "border-red-500" : ""
                }`}
              >
                <SelectValue placeholder="year" />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Select value={hour} onValueChange={setHour}>
                <SelectTrigger
                  className={`w-16 bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} ${
                    errors.date ? "border-red-500" : ""
                  }`}
                >
                  <SelectValue placeholder="0-24" />
                </SelectTrigger>
                <SelectContent>
                  {hours.map((h) => (
                    <SelectItem key={h} value={h.toString().padStart(2, "0")}>
                      {h.toString().padStart(2, "0")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>:</span>
              <Select value={minute} onValueChange={setMinute}>
                <SelectTrigger
                  className={`w-16 bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"} ${
                    errors.date ? "border-red-500" : ""
                  }`}
                >
                  <SelectValue placeholder="0-59" />
                </SelectTrigger>
                <SelectContent>
                  {minutes.map((m) => (
                    <SelectItem key={m} value={m.toString().padStart(2, "0")}>
                      {m.toString().padStart(2, "0")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {errors.date && <p className="text-red-500 text-xs mt-1">{errors.date}</p>}
        </div>
      </div>
    </Card>
  )
}
