import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "../theme";
import { RouteBreadcrumbs } from "./RouteBreadcrumbs";

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <RouteBreadcrumbs />
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  );
}
