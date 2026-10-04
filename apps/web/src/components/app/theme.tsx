import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Monitor, Moon, Sun } from "lucide-react";
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
  setTheme: (theme: AppTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider(props: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(getInitialTheme);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const resolvedTheme = resolveTheme(theme);

  // A user's choice that changes the resolved theme cross-fades the whole
  // document (a View Transition). The load, and a system change, never do.
  const setTheme = useCallback((next: AppTheme) => {
    const commit = () => flushSync(() => setThemeState(next));
    const root = document.documentElement;
    const changes = root.classList.contains("dark") !== (resolveTheme(next) === "dark");
    if (!changes || typeof document.startViewTransition !== "function") {
      commit();
      return;
    }
    document
      .startViewTransition(() => {
        applyTheme(next);
        commit();
      })
      .ready.catch(() => {});
  }, []);

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
      cycleTheme: () => setTheme(getNextTheme(themeRef.current)),
      setTheme,
    }),
    [resolvedTheme, setTheme, theme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycleTheme } = useTheme();
  const { nextLabel } = getThemeMeta(theme);
  // One short, input-neutral phrase names the control and fills the tooltip.
  const name = `Switch to ${nextLabel} theme`;

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
            aria-label={name}
          >
            {/* The three icons share one cell; the current one turns into place. */}
            <span data-theme-icon="" aria-hidden="true">
              <Sun className="size-4" data-on={theme === "light" || undefined} />
              <Moon className="size-4" data-on={theme === "dark" || undefined} />
              <Monitor className="size-4" data-on={theme === "system" || undefined} />
            </span>
          </Button>
        }
      />
      <TooltipContent side="bottom">{name}</TooltipContent>
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
      return { nextLabel: "Dark" };
    case "dark":
      return { nextLabel: "System" };
    default:
      return { nextLabel: "Light" };
  }
}
