import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Laptop2, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const THEME_STORAGE_KEY = "intar-theme";

export type AppTheme = "light" | "dark" | "system";

export const THEME_BOOTSTRAP_SCRIPT = `(() => {
  const key = "${THEME_STORAGE_KEY}";
  let theme = "system";
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "light" || stored === "dark" || stored === "system") {
      theme = stored;
    }
  } catch {}
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolvedTheme = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.style.colorScheme = resolvedTheme;
})();`;

interface ThemeContextValue {
  theme: AppTheme;
  resolvedTheme: Exclude<AppTheme, "system">;
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider(props: { children: ReactNode }) {
  const [theme, setTheme] = useState<AppTheme>(getInitialTheme);
  const resolvedTheme = resolveTheme(theme);

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures and keep the active in-memory theme.
    }
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => applyTheme("system");
    mediaQuery.addEventListener("change", syncTheme);
    return () => mediaQuery.removeEventListener("change", syncTheme);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      cycleTheme: () => setTheme((current) => getNextTheme(current)),
    }),
    [resolvedTheme, theme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycleTheme } = useTheme();
  const { icon, label, nextLabel } = getThemeMeta(theme);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={className}
            onClick={cycleTheme}
            aria-label={`Theme: ${label}. Click to switch to ${nextLabel}.`}
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent side="bottom" sideOffset={8}>
        {label} theme
      </TooltipContent>
    </Tooltip>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

function getInitialTheme(): AppTheme {
  if (typeof document === "undefined") {
    return "system";
  }

  const dataTheme = document.documentElement.dataset.theme;
  if (dataTheme === "light" || dataTheme === "dark" || dataTheme === "system") {
    return dataTheme;
  }

  return "system";
}

function applyTheme(theme: AppTheme) {
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(theme);
  root.dataset.theme = theme;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.style.colorScheme = resolvedTheme;
}

function resolveTheme(theme: AppTheme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  return theme;
}

function getNextTheme(theme: AppTheme): AppTheme {
  if (theme === "system") {
    return "light";
  }

  if (theme === "light") {
    return "dark";
  }

  return "system";
}

function getThemeMeta(theme: AppTheme) {
  switch (theme) {
    case "light":
      return {
        icon: <Sun className="size-4" />,
        label: "Light",
        nextLabel: "Dark",
      };
    case "dark":
      return {
        icon: <Moon className="size-4" />,
        label: "Dark",
        nextLabel: "System",
      };
    default:
      return {
        icon: <Laptop2 className="size-4" />,
        label: "System",
        nextLabel: "Light",
      };
  }
}
