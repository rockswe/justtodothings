"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { X } from "lucide-react"
import { useTheme } from "../contexts/ThemeContext"

interface CanvasLMSInstructionsProps {
  onClose: () => void
  onConnect: (domain: string, accessToken: string) => void
  appType: "canvas" | "gmail"
}

export function CanvasLMSInstructions({ onClose, onConnect, appType }: CanvasLMSInstructionsProps) {
  const [canvasLink, setCanvasLink] = useState("")
  const [accessToken, setAccessToken] = useState("")
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState("")
  const { theme } = useTheme()

  const handleConnect = async () => {
    if (!canvasLink || !accessToken) {
      setError("Please fill in all fields")
      return
    }

    setIsConnecting(true)
    setError("")

    try {
      // Clean up the domain (remove https://, trailing slashes, etc.)
      const domain = canvasLink.replace(/^https?:\/\//, "").replace(/\/$/, "")
      onConnect(domain, accessToken)
    } catch (error) {
      console.error("Error connecting:", error)
      setError("Failed to connect. Please check your credentials and try again.")
      setIsConnecting(false)
    }
  }

  const getTitle = () => {
    return appType === "canvas" ? "connect to canvas lms" : "connect to gmail"
  }

  const getInstructions = () => {
    if (appType === "canvas") {
      return (
        <ol className={`list-decimal list-inside space-y-2 ${theme === "dark" ? "text-white/70" : "text-black/70"}`}>
          <li>click "account" on canvas</li>
          <li>click "settings"</li>
          <li>scroll down to "approved integrations"</li>
          <li>click "+ new access token"</li>
          <li>type justtodothings in the purpose box</li>
          <li>click generate token</li>
          <li>copy the token</li>
        </ol>
      )
    } else {
      return (
        <ol className={`list-decimal list-inside space-y-2 ${theme === "dark" ? "text-white/70" : "text-black/70"}`}>
          <li>sign in to your gmail account</li>
          <li>go to your google account settings</li>
          <li>navigate to the "security" tab</li>
          <li>under "signing in to google," find "app passwords"</li>
          <li>select "mail" as the app and your device</li>
          <li>click "generate"</li>
          <li>copy the 16-character password</li>
        </ol>
      )
    }
  }

  const getInputFields = () => {
    if (appType === "canvas") {
      return (
        <>
          <div className="space-y-2">
            <Label htmlFor="canvasLink">your canvas link</Label>
            <Input
              id="canvasLink"
              type="text"
              value={canvasLink}
              onChange={(e) => setCanvasLink(e.target.value)}
              className={`bg-transparent ${
                theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
              }`}
              placeholder="i.e. usc.instructure.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="accessToken">access token</Label>
            <Input
              id="accessToken"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              className={`bg-transparent ${
                theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
              }`}
              placeholder="Paste your Canvas LMS access token here"
            />
          </div>
        </>
      )
    } else {
      return (
        <>
          <div className="space-y-2">
            <Label htmlFor="gmailAddress">your gmail address</Label>
            <Input
              id="gmailAddress"
              type="email"
              value={canvasLink}
              onChange={(e) => setCanvasLink(e.target.value)}
              className={`bg-transparent ${
                theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
              }`}
              placeholder="your.email@gmail.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="appPassword">app password</Label>
            <Input
              id="appPassword"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              className={`bg-transparent ${
                theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"
              }`}
              placeholder="Paste your 16-character app password here"
            />
          </div>
        </>
      )
    }
  }

  return (
    <Card
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        theme === "dark" ? "bg-black/50" : "bg-white/50"
      }`}
    >
      <Card
        className={`w-full max-w-md ${
          theme === "dark" ? "bg-[#1a1a1a] border-white/20 text-white" : "bg-white border-black/20 text-black"
        }`}
      >
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-xl font-normal">{getTitle()}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {getInstructions()}
          {getInputFields()}
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <Button onClick={handleConnect} className="w-full" disabled={isConnecting}>
            {isConnecting ? "connecting..." : "connect"}
          </Button>
        </CardContent>
      </Card>
    </Card>
  )
}
