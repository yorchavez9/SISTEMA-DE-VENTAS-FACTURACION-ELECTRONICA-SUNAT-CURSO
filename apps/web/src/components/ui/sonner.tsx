import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** El tema de la app se marca con la clase .dark en <html> (lib/tema.ts); se sigue con un observador. */
function useTemaDocumento(): "light" | "dark" {
  const leer = (): "light" | "dark" => (document.documentElement.classList.contains("dark") ? "dark" : "light")
  const [tema, setTema] = useState(leer)
  useEffect(() => {
    const o = new MutationObserver(() => setTema(leer()))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => o.disconnect()
  }, [])
  return tema
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTemaDocumento()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Como ferretería: fondo de la página, sin borde, sombra mínima; solo el icono lleva el color.
      toastOptions={{
        classNames: {
          toast: "!shadow-[var(--sombra-flotante)] !text-[0.8125rem] !font-medium",
          success: "[&_[data-icon]]:text-ok",
          error: "[&_[data-icon]]:text-peligro",
          warning: "[&_[data-icon]]:text-warn",
          info: "[&_[data-icon]]:text-info",
        },
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--background)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
          "--border-radius": "var(--radio-md)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
