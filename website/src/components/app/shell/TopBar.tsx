import { Link } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useMyRuns } from "../hooks/useMyRuns";
import { RouteBreadcrumbs } from "./RouteBreadcrumbs";

export function TopBar() {
  const runs = useMyRuns();
  const activeRun = runs.data?.runs.find((run) => run.active) ?? null;

  return (
    <header className="sticky top-0 z-30 flex min-h-16 shrink-0 items-center gap-2 border-b bg-background px-[var(--page-inset)]">
      <SidebarTrigger className="-ml-1" />
      <RouteBreadcrumbs />
      <div className="ml-auto flex items-center gap-1">
        {activeRun ? (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/runs/$runId" params={{ runId: activeRun.runId }} />}
          >
            <Activity className="size-3.5 text-primary" />
            <span className="hidden min-w-0 max-w-44 truncate sm:inline-block">
              Resume {activeRun.title}
            </span>
            <span className="sm:hidden">Resume lab</span>
          </Button>
        ) : (
          <Button size="sm" variant="ghost" render={<Link to="/scenarios" />}>
            Browse scenarios
          </Button>
        )}
      </div>
    </header>
  );
}
