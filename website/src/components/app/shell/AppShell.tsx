import { useEffect, useRef } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { BreadcrumbProvider } from "./breadcrumbs";
import { TopBar } from "./TopBar";

// The authenticated app surface. Theme follows the user's choice (or system
// preference) via the `.dark` class on <html> — no per-surface mood forcing.
export function AppShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const previousPath = useRef(pathname);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("#main-content")?.focus({
        preventScroll: true,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return (
    <BreadcrumbProvider>
      <SidebarProvider>
        <a
          href="#main-content"
          className="fixed top-3 left-3 z-[100] inline-flex min-h-11 -translate-y-24 items-center rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground shadow-md transition-transform focus:translate-y-0 motion-reduce:transition-none"
        >
          Skip to main content
        </a>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex flex-1 flex-col focus:outline-none"
          >
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </BreadcrumbProvider>
  );
}
