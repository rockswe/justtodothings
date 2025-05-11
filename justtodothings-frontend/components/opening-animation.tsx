"use client"

import { useState, useEffect } from "react"
import { TypeAnimation } from "react-type-animation"
import { useTheme } from "../contexts/ThemeContext"
import { Button } from "@/components/ui/button"

interface OpeningAnimationProps {
  onComplete: () => void
}

export function OpeningAnimation({ onComplete }: OpeningAnimationProps) {
  const [showAnimation, setShowAnimation] = useState(true)
  const [skipped, setSkipped] = useState(false)
  const { theme } = useTheme()

  useEffect(() => {
    if (skipped) {
      setShowAnimation(false)
      onComplete()
      return
    }

    const timer = setTimeout(() => {
      setShowAnimation(false)
      onComplete()
    }, 15000)

    return () => clearTimeout(timer)
  }, [onComplete, skipped])

  if (!showAnimation) return null

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-gray-200">
      <style jsx>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .terminal-cursor {
          display: inline-block;
          width: 0.6em;
          height: 1.2em;
          vertical-align: text-bottom;
          background-color: #4a5568;
          animation: blink 1s step-end infinite;
        }
      `}</style>
      <div className="font-mono text-xl md:text-2xl lg:text-3xl text-gray-800 relative">
        <TypeAnimation
          sequence={[
            '$ just "to-do" things',
            1000, // Pause for 1 second after "just to-do things"
            "$ ",
            150, // Reduced pause for the empty line
            "$ inbox chaos → clear tasks",
            1000, // Pause for 1 second after this line
            "$ ",
            150, // Reduced pause for the empty line
            "$ deadlines handled for you",
            1000, // Pause for 1 second after this line
            "$ ",
            150,
            "$ example usage",
            1000, // Pause for 1 second after "example usage"
            "$ ",
            150,
          ]}
          wrapper="span"
          cursor={false}
          repeat={0}
          style={{ display: "inline" }}
          speed={50}
          key={skipped ? "skipped" : "normal"}
        />
        <span className="terminal-cursor" aria-hidden="true"></span>
        <Button
          variant="outline"
          className="fixed bottom-4 left-1/2 transform -translate-x-1/2"
          onClick={() => setSkipped(true)}
        >
          skip
        </Button>
      </div>
    </div>
  )
}
