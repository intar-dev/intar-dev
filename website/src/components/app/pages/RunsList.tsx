import { Link } from "@tanstack/react-router";
import { BookOpen, ListChecks } from "lucide-react";
import { PageHeader } from "../patterns/PageHeader";
import { EmptyState } from "../patterns/StateCard";
import { Button } from "@/components/ui/button";

// Placeholder learner run-list. Phase 1 replaces this with the real
// per-user run history + active runs and moves run detail to /runs/$runId.
export function RunsList() {
  return (
    <>
      <PageHeader
        eyebrow="Activity"
        title="My runs"
        description="Your active and past scenario runs will live here."
      />
      <EmptyState
        icon={<ListChecks className="size-6" />}
        title="A dedicated run history is coming"
        description="For now, start a scenario to launch a run — active runs and replays are shown on each scenario's briefing."
        action={
          <Button render={<Link to="/scenarios" />}>
            <BookOpen className="size-4" />
            Browse scenarios
          </Button>
        }
      />
    </>
  );
}
