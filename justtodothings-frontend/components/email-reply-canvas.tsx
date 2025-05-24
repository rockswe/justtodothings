"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { X, Send, RefreshCw } from "lucide-react"
import { useTheme } from "../contexts/ThemeContext"
import { useToast } from "@/hooks/use-toast"
import type { Task } from "@/services/api"

interface EmailReplyCanvasProps {
  task: Task
  initialDraft: string
  onClose: () => void
  onRewrite: (instructions: string) => Promise<void>
  onSend: (emailBody: string) => Promise<void>
  isLoading: boolean
}

export function EmailReplyCanvas({ task, initialDraft, onClose, onRewrite, onSend, isLoading }: EmailReplyCanvasProps) {
  const [currentDraft, setCurrentDraft] = useState(initialDraft)
  const [rewritePromptVisible, setRewritePromptVisible] = useState(false)
  const [rewriteInstructions, setRewriteInstructions] = useState("")
  const { theme } = useTheme()
  const { toast } = useToast()

  // Update the draft if the initialDraft prop changes
  useEffect(() => {
    setCurrentDraft(initialDraft)
  }, [initialDraft])

  const handleRewriteClick = () => {
    setRewritePromptVisible(true)
  }

  const handleRewriteSubmit = async () => {
    if (!rewriteInstructions.trim()) {
      toast({
        title: "Error",
        description: "Please provide instructions for rewriting the draft.",
        variant: "destructive",
      })
      return
    }

    try {
      await onRewrite(rewriteInstructions)
      setRewritePromptVisible(false)
      setRewriteInstructions("")
    } catch (error) {
      console.error("Error rewriting draft:", error)
      toast({
        title: "Error",
        description: "Failed to rewrite the draft. Please try again.",
        variant: "destructive",
      })
    }
  }

  const handleSendClick = async () => {
    if (!currentDraft.trim()) {
      toast({
        title: "Error",
        description: "Cannot send an empty email.",
        variant: "destructive",
      })
      return
    }

    try {
      await onSend(currentDraft)
    } catch (error) {
      console.error("Error sending email:", error)
      toast({
        title: "Error",
        description: "Failed to send the email. Please try again.",
        variant: "destructive",
      })
    }
  }

  return (
    <Card
      className={`fixed inset-0 z-50 flex flex-col p-4 m-4 max-w-3xl mx-auto max-h-[90vh] ${
        theme === "dark" ? "bg-[#1a1a1a] border-white/20 text-white" : "bg-white border-black/20 text-black"
      }`}
    >
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-medium">Email Reply: {task.title}</h3>
        <Button variant="ghost" size="icon" onClick={onClose} disabled={isLoading}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-grow overflow-auto mb-4">
        <Textarea
          value={currentDraft}
          onChange={(e) => setCurrentDraft(e.target.value)}
          className={`min-h-[300px] w-full p-3 ${
            theme === "dark" ? "bg-[#2a2a2a] border-white/20 text-white" : "bg-gray-50 border-black/20 text-black"
          } resize-none`}
          placeholder="Email draft content..."
          disabled={isLoading}
        />
      </div>

      {rewritePromptVisible ? (
        <div className="mb-4 space-y-2">
          <Textarea
            value={rewriteInstructions}
            onChange={(e) => setRewriteInstructions(e.target.value)}
            className={`w-full p-3 ${
              theme === "dark" ? "bg-[#2a2a2a] border-white/20 text-white" : "bg-gray-50 border-black/20 text-black"
            }`}
            placeholder="Provide instructions for rewriting (e.g., 'Make it more formal', 'Shorten it', etc.)"
            disabled={isLoading}
          />
          <div className="flex justify-end space-x-2">
            <Button variant="outline" size="sm" onClick={() => setRewritePromptVisible(false)} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleRewriteSubmit}
              disabled={isLoading}
              className={theme === "dark" ? "bg-white text-black hover:bg-white/90" : ""}
            >
              {isLoading ? "Rewriting..." : "Rewrite"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={handleRewriteClick}
            disabled={isLoading}
            className="flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Rewrite Draft
          </Button>
          <div className="space-x-2">
            <Button variant="outline" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={handleSendClick}
              disabled={isLoading}
              className={`flex items-center gap-2 ${theme === "dark" ? "bg-white text-black hover:bg-white/90" : ""}`}
            >
              <Send className="h-4 w-4" />
              {isLoading ? "Sending..." : "Send Email"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
