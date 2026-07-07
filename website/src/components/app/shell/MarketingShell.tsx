import { Outlet } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useTheme } from "../theme";

// The public marketing surface: warm/light mood by default (when the user's
// choice is "system"), honoring an explicit toggle. Same descendant-scoped
// `dark` mechanism as AppShell.
export function MarketingShell() {
  const { theme, resolvedTheme } = useTheme();
  const mood = theme === "system" ? "light" : resolvedTheme;

  return (
    <div
      data-surface="marketing"
      className={cn(
        "min-h-screen text-foreground",
        mood === "dark" && "dark",
      )}
    >
      <Outlet />
    </div>
  );
}
