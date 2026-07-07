import { CheckCircle2, Circle, CircleAlert } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { parseProbeValue } from "@/lib/probe-values";
import { cn } from "@/lib/utils";
import { ProbeDetail } from "./ProbeDetail";
import { describeProbeValue } from "./run-support";
import type { ScenarioObjective, ScenarioProbeStatus } from "./run-types";

// The progress heartbeat of the run workspace. Passed objectives collapse to
// a single check line; open ones keep their guidance expanded.
export function ScenarioProbeRail(props: {
  title: string;
  description: string;
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  const passed = props.probes.filter((probe) => probe.status === "pass").length;
  const total = props.probes.length;

  return (
    <Card size="sm">
      <CardHeader className="gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle className="font-heading text-base">
            {props.title}
          </CardTitle>
          {total ? (
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {passed}/{total} complete
            </span>
          ) : null}
        </div>
        {total ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-500"
              style={{ width: `${total ? (passed / total) * 100 : 0}%` }}
            />
          </div>
        ) : null}
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {props.probes.length ? (
          props.probes.map((probe) => {
            const objective = props.objectives.find(
              (candidate) => candidate.probeName === probe.id,
            );
            const title = objective?.title?.trim() || probe.label;

            if (probe.status === "pass") {
              return (
                <div
                  key={probe.id}
                  className="rounded-lg bg-success/8 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2
                      className="size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <p className="min-w-0 truncate text-sm font-medium text-success">
                      {title}
                    </p>
                  </div>
                  {probe.error ? (
                    <p className="mt-1.5 pl-6.5 text-xs text-destructive">
                      {probe.error}
                    </p>
                  ) : null}
                </div>
              );
            }

            const failed = probe.status === "fail";
            return (
              <div
                key={probe.id}
                className={cn(
                  "rounded-lg border px-3 py-3",
                  failed && "border-destructive/30 bg-destructive/5",
                )}
              >
                <div className="flex items-start gap-2.5">
                  {failed ? (
                    <CircleAlert
                      className="mt-0.5 size-4 shrink-0 text-destructive"
                      aria-hidden="true"
                    />
                  ) : (
                    <Circle
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground/50"
                      aria-hidden="true"
                    />
                  )}
                  <p className="min-w-0 flex-1 text-sm font-medium">{title}</p>
                </div>
                {objective?.bodyMarkdown ? (
                  <Markdown className="mt-2.5 space-y-2 pl-6.5 text-xs leading-6 text-muted-foreground">
                    {objective.bodyMarkdown}
                  </Markdown>
                ) : null}
                {probe.error ? (
                  <p className="mt-2 pl-6.5 text-xs text-destructive">
                    {probe.error}
                  </p>
                ) : failed && parseProbeValue(probe.kind, probe.value) ? (
                  <ProbeDetail
                    kind={probe.kind}
                    value={probe.value}
                    className="mt-3 ml-6.5 rounded-md border border-destructive/20 bg-background/60 p-2.5"
                  />
                ) : (
                  <p className="mt-2 pl-6.5 text-xs text-muted-foreground">
                    {describeProbeValue(probe)}
                  </p>
                )}
              </div>
            );
          })
        ) : (
          <p className="px-1 py-4 text-sm text-muted-foreground">
            No checks in this section.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
