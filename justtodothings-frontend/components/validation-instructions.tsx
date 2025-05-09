"use client"

import { useState, useEffect } from "react"
import { Check, X } from "lucide-react"
import { useTheme } from "../contexts/ThemeContext"

interface ValidationRule {
  id: string
  label: string
  validate: (value: string) => boolean
}

interface ValidationInstructionsProps {
  value: string
  type: "password" | "email" | "title" | "name" | "message"
  showAll?: boolean
}

export function ValidationInstructions({ value, type, showAll = false }: ValidationInstructionsProps) {
  const { theme } = useTheme()
  const [rules, setRules] = useState<ValidationRule[]>([])
  const [showInstructions, setShowInstructions] = useState(false)

  useEffect(() => {
    // Define validation rules based on type
    if (type === "password") {
      setRules([
        {
          id: "length",
          label: "at least 8 characters",
          validate: (val) => val.length >= 8,
        },
        {
          id: "uppercase",
          label: "one uppercase letter",
          validate: (val) => /[A-Z]/.test(val),
        },
        {
          id: "lowercase",
          label: "one lowercase letter",
          validate: (val) => /[a-z]/.test(val),
        },
        {
          id: "number",
          label: "one number",
          validate: (val) => /\d/.test(val),
        },
        {
          id: "special",
          label: "one special character",
          validate: (val) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(val),
        },
      ])
    } else if (type === "email") {
      setRules([
        {
          id: "email",
          label: "valid email address",
          validate: (val) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val),
        },
      ])
    } else if (type === "title") {
      setRules([
        {
          id: "required",
          label: "title is required",
          validate: (val) => val.trim().length > 0,
        },
        {
          id: "length",
          label: "maximum 255 characters",
          validate: (val) => val.length <= 255,
        },
      ])
    } else if (type === "name") {
      setRules([
        {
          id: "required",
          label: "name is required",
          validate: (val) => val.trim().length > 0,
        },
        {
          id: "length",
          label: "maximum 100 characters",
          validate: (val) => val.length <= 100,
        },
      ])
    } else if (type === "message") {
      setRules([
        {
          id: "required",
          label: "message is required",
          validate: (val) => val.trim().length > 0,
        },
        {
          id: "length",
          label: "maximum 2000 characters",
          validate: (val) => val.length <= 2000,
        },
      ])
    }
  }, [type])

  useEffect(() => {
    // Show instructions when the user starts typing or if showAll is true
    if (showAll) {
      setShowInstructions(true)
    } else {
      setShowInstructions(value.length > 0)
    }
  }, [value, showAll])

  // If this is for a todo title, don't show validation instructions
  if (type === "title") return null

  if (!showInstructions) return null

  return (
    <div className="mt-2 text-xs space-y-1">
      {rules.map((rule) => {
        const isValid = rule.validate(value)
        const showValidation = value.length > 0 || showAll

        return (
          <div key={rule.id} className="flex items-center gap-2">
            {showValidation ? (
              isValid ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <X className="h-3 w-3 text-red-500" />
              )
            ) : (
              <div className="h-3 w-3" />
            )}
            <span
              className={
                showValidation
                  ? isValid
                    ? "text-green-500"
                    : "text-red-500"
                  : theme === "dark"
                    ? "text-white/60"
                    : "text-black/60"
              }
            >
              {rule.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
