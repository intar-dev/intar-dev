import { useEffect, useRef } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { AppBar } from "./AppBar";
import { PageChromeProvider, usePageChromeValue } from "./page-chrome";

// The authenticated app surface. Theme follows the user's choice (or system
// preference) via the `.dark` class on <html> — no per-surface mood forcing.
export function AppShell() {
  return (
    <PageChromeProvider>
      <AppShellContent />
    </PageChromeProvider>
  );
}

function AppShellContent() {
  const pathname = useRouterState({
    // Match page chrome's committed-location key. During navigation, the
    // current outlet must keep controlling the shell until its replacement
    // has actually rendered.
    select: (state) =>
      state.resolvedLocation?.pathname ?? state.location.pathname,
  });
  const previousPath = useRef(pathname);
  const fullscreenWorkspace = usePageChromeValue(pathname)?.fullscreen === true;

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
    <SidebarProvider
          className={fullscreenWorkspace ? "min-h-[100dvh]" : undefined}
          keyboardShortcutEnabled={!fullscreenWorkspace}
        >
          <AppShellNavigation hidden={fullscreenWorkspace} />
          <SidebarInset
            className={
              fullscreenWorkspace ? "min-h-[100dvh] min-w-0" : "min-w-0"
            }
          >
            {fullscreenWorkspace ? null : <AppBar />}
            <main
              id="main-content"
              tabIndex={-1}
              className={`flex min-w-0 flex-1 flex-col focus:outline-none${
                fullscreenWorkspace ? " min-h-[100dvh]" : ""
              }`}
            >
              <Outlet />
            </main>
          </SidebarInset>
    </SidebarProvider>
  );
}

// Keep this component in the tree while a run changes activity. It preserves
// SidebarInset and its Outlet identity, so ScenarioRun does not remount when
// the active workspace returns to the normal app chrome for saving or recap.
function AppShellNavigation({ hidden }: { hidden: boolean }) {
  if (hidden) return null;

  return (
    <>
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-[100] inline-flex min-h-11 -translate-y-24 items-center rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground shadow-md transition-transform focus:translate-y-0 motion-reduce:transition-none"
      >
        Skip to main content
      </a>
      <AppSidebar />
    </>
  );
}
