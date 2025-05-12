"use client"

import { useState, useEffect, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { X, BookOpen, Mail, Github, Slack } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useTheme } from "../contexts/ThemeContext"
import { CanvasLMSInstructions } from "./canvas-lms-instructions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { settingsAPI, connectedAppsAPI, type UserSettings } from "@/services/api"

interface SettingsCardProps {
  onClose: () => void
  onLogout: () => void
  onDeleteAllTodos: () => void
  onDeleteAccount?: () => void
  isSignedUp?: boolean
}

type Category = "general" | "connectedApps"
type ConnectedApp = "canvas" | "gmail" | "github" | "slack"

export function SettingsCard({
  onClose,
  onLogout,
  onDeleteAllTodos,
  onDeleteAccount,
  isSignedUp = false,
}: SettingsCardProps) {
  const { theme, setTheme } = useTheme()
  const [activeCategory, setActiveCategory] = useState<Category>("general")
  const [notifications, setNotifications] = useState(true)
  const [showCanvasInstructions, setShowCanvasInstructions] = useState(false)
  const [showSignUpAlert, setShowSignUpAlert] = useState(false)
  const [showDeleteAccountAlert, setShowDeleteAccountAlert] = useState(false)
  const [selectedApp, setSelectedApp] = useState<ConnectedApp | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null)

  const searchParams = useSearchParams()
  const router = useRouter()

  const fetchSettings = useCallback(async () => {
    if (!isSignedUp) {
      return
    }
    setIsLoading(true)
    try {
      const newSettings = await settingsAPI.getSettings()
      if (!newSettings) {
        console.error("[fetchSettings] Fetched settings data is null or undefined. Aborting update.")
        return
      }
      const currentConnectedApps = newSettings.connected_apps || {}
      setUserSettings({
        ...newSettings,
        connected_apps: currentConnectedApps
      } as UserSettings)
      if (newSettings.theme_preference) {
        setTheme(newSettings.theme_preference)
      }
      if (typeof newSettings.notifications_enabled === 'boolean') {
        setNotifications(newSettings.notifications_enabled)
      }
    } catch (error) {
      console.error("Error in fetchSettings execution:", error)
    } finally {
      setIsLoading(false)
    }
  }, [isSignedUp, setTheme, setNotifications, setIsLoading, setUserSettings])

  // Load settings on component mount
  useEffect(() => {
    if (isSignedUp) {
      fetchSettings()
    } else {
      // For non-signed-up users, use localStorage for theme preference
      const savedTheme = localStorage.getItem("theme") as "dark" | "light" | null
      if (savedTheme) {
        setTheme(savedTheme)
      }

      // For non-signed-up users, default notifications to true
      setNotifications(true)
    }
  }, [isSignedUp, setTheme, fetchSettings])

  // Effect to handle OAuth redirect
  useEffect(() => {
    const app = searchParams.get("app")
    const status = searchParams.get("status")
    const message = searchParams.get("message")

    if (app && status) {
      const newSearchParams = new URLSearchParams(searchParams.toString())
      newSearchParams.delete("app")
      newSearchParams.delete("status")
      newSearchParams.delete("message")
      
      const newUrl = `${window.location.pathname}?${newSearchParams.toString()}`.replace(/\?$/, '') // Remove trailing '?' if no params left
      router.replace(newUrl, { scroll: false }) // Clean URL immediately

      if (status === "success" && ["gmail", "github", "slack", "canvas"].includes(app)) {
        fetchSettings() // Call the memoized fetchSettings
      } else if (status === "error") {
        console.error(`OAuth error for ${app}: ${message || 'Unknown error'}`)
        // Optionally: Display a toast to the user with the error message
      }
    }
  }, [searchParams, router, fetchSettings]) // Dependencies for the OAuth effect

  const handleThemeChange = async (value: string) => {
    setTheme(value as "dark" | "light")

    if (isSignedUp) {
      try {
        const updatedSettings = await settingsAPI.updateSettings({ theme_preference: value as "dark" | "light" })
        setUserSettings(updatedSettings)
      } catch (error) {
        console.error("Error updating theme:", error)
      }
    } else {
      // For non-signed-up users, store theme in localStorage
      localStorage.setItem("theme", value)
    }
  }

  const handleNotificationsToggle = async () => {
    const newValue = !notifications
    setNotifications(newValue)

    if (isSignedUp) {
      try {
        const updatedSettings = await settingsAPI.updateSettings({ notifications_enabled: newValue })
        setUserSettings(updatedSettings)
      } catch (error) {
        console.error("Error updating notifications:", error)
      }
    }
  }

  const handleAppConnection = (app: ConnectedApp) => {
    if (!isSignedUp) {
      setShowSignUpAlert(true)
      return
    }

    // Ensure this uses NEXT_PUBLIC_ for client-side access
    const effectiveApiUrl = process.env.NEXT_PUBLIC_API_URL || "https://api.justtodothings.com";

    if (isAppConnected(app)) {
      handleDisconnectApp(app)
    } else {
      setSelectedApp(app)
      if (app === "canvas") {
        setShowCanvasInstructions(true)
      } else if (app === "gmail") {
        window.location.href = new URL('/connected-apps/gmail', effectiveApiUrl).href;
      } else if (app === "github") {
        window.location.href = new URL('/connected-apps/github', effectiveApiUrl).href;
      } else if (app === "slack") {
        window.location.href = new URL('/connected-apps/slack', effectiveApiUrl).href;
      }
    }
  }

  const handleConnectApp = async (app: ConnectedApp, domain?: string, accessToken?: string) => {
    if (!isSignedUp) return

    try {
      setIsLoading(true)
      if (app === "canvas" && domain && accessToken) {
        const result = await connectedAppsAPI.connectCanvas(domain, accessToken)
        // Update the user settings with the new connected app data
        if (result && userSettings) {
          setUserSettings({
            ...userSettings,
            connected_apps: {
              ...userSettings.connected_apps,
              canvas: { canvasUserId: result.canvasUserId, domain },
            },
          })
        }
        // Refresh settings to ensure we have the latest data
        await fetchSettings()
      }
    } catch (error) {
      console.error(`Error connecting ${app}:`, error)
    } finally {
      setIsLoading(false)
      setShowCanvasInstructions(false)
    }
  }

  const handleDisconnectApp = async (app: ConnectedApp) => {
    if (!isSignedUp) return

    try {
      setIsLoading(true)
      if (app === "canvas") {
        await connectedAppsAPI.disconnectCanvas()
      } else if (app === "gmail") {
        await connectedAppsAPI.disconnectGmail()
      } else if (app === "github") {
        await connectedAppsAPI.disconnectGitHub()
      } else if (app === "slack") {
        await connectedAppsAPI.disconnectSlack()
      }

      // Refresh settings to ensure we have the latest data
      await fetchSettings()
    } catch (error) {
      console.error(`Error disconnecting ${app}:`, error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeleteAccount = () => {
    if (onDeleteAccount) {
      onDeleteAccount()
    }
    setShowDeleteAccountAlert(false)
  }

  // Check if an app is connected based on the backend settings
  const isAppConnected = (app: ConnectedApp): boolean => {
    if (!isSignedUp || !userSettings || !userSettings.connected_apps) {
      return false
    }
    return !!userSettings.connected_apps[app]
  }

  return (
    <Card
      className={`w-full max-w-5xl mx-auto max-h-[80vh] flex flex-col ${
        theme === "dark" ? "bg-[#1a1a1a] border-white/20 text-white" : "bg-white border-black/20 text-black"
      }`}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-2xl font-normal">settings</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col md:flex-row p-4 flex-1 overflow-y-auto">
        <div
          className={`w-full md:w-1/4 space-y-1 pb-4 md:pb-0 border-b ${theme === "dark" ? "border-white/20" : "border-black/20"} md:border-b-0 md:border-r ${theme === "dark" ? "border-white/20" : "border-black/20"} md:pr-4`}
        >
          <Button
            variant="ghost"
            className="w-full justify-center py-1 px-2 text-sm whitespace-normal"
            onClick={() => setActiveCategory("general")}
          >
            general
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-center py-1 px-2 text-sm whitespace-normal"
            onClick={() => setActiveCategory("connectedApps")}
          >
            connected apps
          </Button>
        </div>

        <div className="w-full md:w-3/4 md:pl-5 pt-4 md:pt-0 space-y-6 overflow-y-auto pb-4">
          {activeCategory === "general" && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <span className="mr-4">theme</span>
                <Select value={theme} onValueChange={handleThemeChange}>
                  <SelectTrigger
                    className={`w-[120px] bg-transparent ${theme === "dark" ? "border-white/20 text-white" : "border-black/20 text-black"}`}
                  >
                    <SelectValue placeholder="Select theme" />
                  </SelectTrigger>
                  <SelectContent
                    className={theme === "dark" ? "bg-[#1a1a1a] border-white/20" : "bg-white border-black/20"}
                  >
                    <SelectItem
                      value="light"
                      className={theme === "dark" ? "text-white hover:bg-white/10" : "text-black hover:bg-black/10"}
                    >
                      light
                    </SelectItem>
                    <SelectItem
                      value="dark"
                      className={theme === "dark" ? "text-white hover:bg-white/10" : "text-black hover:bg-black/10"}
                    >
                      dark
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-between items-center">
                <span>notifications</span>
                <Switch
                  checked={notifications}
                  onCheckedChange={handleNotificationsToggle}
                  className="bg-gray-600 data-[state=checked]:bg-blue-500"
                />
              </div>
              <Button variant="outline" className="w-full" onClick={onDeleteAllTodos} disabled={isLoading}>
                {isLoading ? "deleting..." : "delete all todos"}
              </Button>

              {/* Only show logout button if user is signed up */}
              {isSignedUp && (
                <Button variant="outline" className="w-full" onClick={onLogout} disabled={isLoading}>
                  {isLoading ? "logging out..." : "log out"}
                </Button>
              )}

              {isSignedUp && (
                <Button
                  variant="destructive"
                  className="w-full bg-red-700 hover:bg-red-800"
                  onClick={() => setShowDeleteAccountAlert(true)}
                  disabled={isLoading}
                >
                  {isLoading ? "deleting..." : "delete account"}
                </Button>
              )}
            </div>
          )}

          {activeCategory === "connectedApps" && (
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <BookOpen className="h-4 w-4" />
                  <span>canvas lms</span>
                </h3>
                <p className={`text-sm ${theme === "dark" ? "text-white/70" : "text-black/70"} mb-4`}>
                  follow your university course pace with AI-powered automation. context-aware task generation, where
                  student productivity is boosted by providing personalized insights, such as relevant assignment
                  reminders, suggested study priorities, and timely progress updates.
                </p>
                <Button
                  variant={isAppConnected("canvas") ? "destructive" : "outline"}
                  className={`w-full ${isAppConnected("canvas") ? "bg-red-600 hover:bg-red-700 text-white" : ""}`}
                  onClick={() => handleAppConnection("canvas")}
                  disabled={isLoading}
                >
                  {isLoading && selectedApp === "canvas"
                    ? "processing..."
                    : isAppConnected("canvas")
                      ? "disconnect"
                      : "connect"}
                </Button>
                {isAppConnected("canvas") && userSettings?.connected_apps?.canvas && (
                  <p className={`text-xs mt-2 ${theme === "dark" ? "text-white/50" : "text-black/50"}`}>
                    connected to {userSettings.connected_apps.canvas.domain}
                  </p>
                )}
              </div>
              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  <span>gmail</span>
                </h3>
                <p className={`text-sm ${theme === "dark" ? "text-white/70" : "text-black/70"} mb-4`}>
                  justtodothings simplifies task management by seamlessly integrating gmail with AI. the AI analyzes
                  your recent emails, extracts key points, and generates concise to-dos, helping you stay organized and
                  focused effortlessly.
                </p>
                <Button
                  variant={isAppConnected("gmail") ? "destructive" : "outline"}
                  className={`w-full ${isAppConnected("gmail") ? "bg-red-600 hover:bg-red-700 text-white" : ""}`}
                  onClick={() => handleAppConnection("gmail")}
                  disabled={isLoading}
                >
                  {isLoading && selectedApp === "gmail"
                    ? "processing..."
                    : isAppConnected("gmail")
                      ? "disconnect"
                      : "connect"}
                </Button>
                {isAppConnected("gmail") && userSettings?.connected_apps?.gmail && (
                  <p className={`text-xs mt-2 ${theme === "dark" ? "text-white/50" : "text-black/50"}`}>
                    connected to {userSettings.connected_apps.gmail.email}
                  </p>
                )}
              </div>
              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Github className="h-4 w-4" />
                  <span>github</span>
                </h3>
                <p className={`text-sm ${theme === "dark" ? "text-white/70" : "text-black/70"} mb-4`}>
                  connect your github account to automatically create tasks from issues and pull requests. stay on top
                  of your development workflow by tracking code reviews, issue assignments, and project milestones.
                </p>
                <Button
                  variant={isAppConnected("github") ? "destructive" : "outline"}
                  className={`w-full ${isAppConnected("github") ? "bg-red-600 hover:bg-red-700 text-white" : ""}`}
                  onClick={() => handleAppConnection("github")}
                  disabled={isLoading}
                >
                  {isLoading && selectedApp === "github"
                    ? "processing..."
                    : isAppConnected("github")
                      ? "disconnect"
                      : "connect"}
                </Button>
                {isAppConnected("github") && userSettings?.connected_apps?.github && (
                  <p className={`text-xs mt-2 ${theme === "dark" ? "text-white/50" : "text-black/50"}`}>
                    connected as {userSettings.connected_apps.github.login}
                  </p>
                )}
              </div>
              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Slack className="h-4 w-4" />
                  <span>slack</span>
                </h3>
                <p className={`text-sm ${theme === "dark" ? "text-white/70" : "text-black/70"} mb-4`}>
                  integrate with slack to turn messages into actionable tasks. never miss important requests from your
                  team and keep track of your commitments across channels and direct messages.
                </p>
                <Button
                  variant={isAppConnected("slack") ? "destructive" : "outline"}
                  className={`w-full ${isAppConnected("slack") ? "bg-red-600 hover:bg-red-700 text-white" : ""}`}
                  onClick={() => handleAppConnection("slack")}
                  disabled={isLoading}
                >
                  {isLoading && selectedApp === "slack"
                    ? "processing..."
                    : isAppConnected("slack")
                      ? "disconnect"
                      : "connect"}
                </Button>
                {isAppConnected("slack") && userSettings?.connected_apps?.slack && (
                  <p className={`text-xs mt-2 ${theme === "dark" ? "text-white/50" : "text-black/50"}`}>
                    connected to workspace {userSettings.connected_apps.slack.team_id}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
      {showCanvasInstructions && (
        <CanvasLMSInstructions
          onClose={() => setShowCanvasInstructions(false)}
          onConnect={(domain, accessToken) => selectedApp && handleConnectApp(selectedApp, domain, accessToken)}
          appType={selectedApp || "canvas"}
        />
      )}
      <AlertDialog open={showSignUpAlert} onOpenChange={setShowSignUpAlert}>
        <AlertDialogContent className={theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"}>
          <AlertDialogHeader>
            <AlertDialogTitle className={theme === "dark" ? "text-white" : "text-black"}>
              sign up required
            </AlertDialogTitle>
            <AlertDialogDescription className={theme === "dark" ? "text-white/70" : "text-black/70"}>
              you have to sign up first to connect to apps.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => setShowSignUpAlert(false)}
              className={
                theme === "dark" ? "bg-white text-black hover:bg-white/90" : "bg-black text-white hover:bg-black/90"
              }
            >
              okay
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={showDeleteAccountAlert} onOpenChange={setShowDeleteAccountAlert}>
        <AlertDialogContent className={theme === "dark" ? "bg-[#1a1a1a] text-white" : "bg-white text-black"}>
          <AlertDialogHeader>
            <AlertDialogTitle className={theme === "dark" ? "text-white" : "text-black"}>
              delete account
            </AlertDialogTitle>
            <AlertDialogDescription className={theme === "dark" ? "text-white/70" : "text-black/70"}>
              are you sure you want to delete your account? this action cannot be undone and all your data will be
              permanently lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className={
                theme === "dark"
                  ? "bg-transparent border-white text-white hover:bg-white/10"
                  : "bg-transparent border-black text-black hover:bg-black/10"
              }
            >
              cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAccount} className="bg-red-600 text-white hover:bg-red-700">
              delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
