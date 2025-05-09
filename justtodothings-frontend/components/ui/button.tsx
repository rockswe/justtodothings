import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { useTheme } from "../../contexts/ThemeContext"

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "",
        destructive: "",
        outline: "",
        secondary: "",
        ghost: "",
        link: "",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const { theme } = useTheme()
    const Comp = asChild ? Slot : "button"

    const getThemeClasses = () => {
      const baseClasses = {
        default: theme === "dark" ? "bg-white text-black hover:bg-white/90" : "bg-black text-white hover:bg-black/90",
        destructive: "bg-red-500 text-white hover:bg-red-600",
        outline:
          theme === "dark"
            ? "border border-white text-white hover:bg-white hover:text-black"
            : "border border-black text-black hover:bg-black hover:text-white",
        secondary:
          theme === "dark" ? "bg-gray-600 text-white hover:bg-gray-700" : "bg-gray-200 text-black hover:bg-gray-300",
        ghost: theme === "dark" ? "text-white hover:bg-white/10" : "text-black hover:bg-black/10",
        link:
          theme === "dark"
            ? "text-white underline-offset-4 hover:underline"
            : "text-black underline-offset-4 hover:underline",
      }

      return baseClasses[variant as keyof typeof baseClasses] || baseClasses.default
    }

    return <Comp className={cn(buttonVariants({ variant, size, className }), getThemeClasses())} ref={ref} {...props} />
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
