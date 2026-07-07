import { Outlet } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { BreadcrumbProvider } from "./breadcrumbs";
import { TopBar } from "./TopBar";

// The authenticated app surface. Theme follows the user's choice (or system
// preference) via the `.dark` class on <html> — no per-surface mood forcing.
export function AppShell() {
  return (
    <BreadcrumbProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main className="flex flex-1 flex-col gap-8 p-6 sm:p-8 lg:p-10">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </BreadcrumbProvider>
  );
}
