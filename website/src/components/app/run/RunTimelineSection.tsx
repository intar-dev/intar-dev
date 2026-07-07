import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ObjectiveTimeline } from "./ObjectiveTimeline";

// Timeline stays collapsed by default; ObjectiveTimeline only mounts (and
// fetches) when expanded, keeping it off the run poll's hot path.
export function RunTimelineSection({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          <span>
            <CardTitle className="text-base">Timeline</CardTitle>
            <CardDescription>When each check flipped.</CardDescription>
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </CardHeader>
      {open ? (
        <CardContent>
          <ObjectiveTimeline runId={runId} />
        </CardContent>
      ) : null}
    </Card>
  );
}
