import { Outlet } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useTheme } from "../theme";
import { AppSidebar } from "./AppSidebar";
import { TopBar } from "./TopBar";

// The authenticated app surface: dark-first "mission-control" mood by default
// (when the user's choice is "system"), still honoring an explicit light/dark
// toggle. The `dark` class is descendant-scoped in global.css, so wrapping the
// subtree flips the whole palette without touching the html element.
export function AppShell() {
  const { theme, resolvedTheme } = useTheme();
  const mood = theme === "system" ? "dark" : resolvedTheme;

  return (
    <div data-surface="app" className={cn(mood === "dark" && "dark")}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
