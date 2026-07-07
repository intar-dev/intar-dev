import { Markdown } from "@/components/app/Markdown";
import { Badge } from "@/components/ui/badge";
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

export function ScenarioProbeRail(props: {
  title: string;
  description: string;
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {props.probes.length ? (
          props.probes.map((probe) => {
            const objective = props.objectives.find(
              (candidate) => candidate.probeName === probe.id,
            );
            return (
              <div
                key={probe.id}
                className={cn(
                  "rounded-lg border px-3 py-3",
                  probe.status === "pass"
                    ? "border-success/30 bg-success/[0.06]"
                    : probe.status === "fail"
                      ? "border-destructive/30 bg-destructive/5"
                      : "",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "truncate text-sm font-medium",
                        probe.status === "pass"
                          ? "text-success"
                          : "text-foreground",
                      )}
                    >
                      {objective?.title?.trim() || probe.label}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-xs",
                        probe.status === "pass"
                          ? "text-success/75"
                          : "text-muted-foreground",
                      )}
                    >
                      {probe.kind}
                    </p>
                  </div>
                  <ProbeBadge status={probe.status} />
                </div>
                {objective?.bodyMarkdown ? (
                  <Markdown
                    className={cn(
                      "mt-3 space-y-2 text-xs leading-6",
                      probe.status === "pass"
                        ? "text-success/85"
                        : "text-muted-foreground",
                    )}
                  >
                    {objective.bodyMarkdown}
                  </Markdown>
                ) : null}
                {probe.error ? (
                  <p className="mt-2 text-xs text-destructive">{probe.error}</p>
                ) : probe.status === "fail" &&
                  parseProbeValue(probe.kind, probe.value) ? (
                  <ProbeDetail
                    kind={probe.kind}
                    value={probe.value}
                    className="mt-3 rounded-md border border-destructive/20 bg-background/60 p-2.5"
                  />
                ) : (
                  <p
                    className={cn(
                      "mt-2 text-xs",
                      probe.status === "pass"
                        ? "text-success/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {describeProbeValue(probe)}
                  </p>
                )}
              </div>
            );
          })
        ) : (
          <div className="border border-dashed border-border/70 px-3 py-6 text-sm text-muted-foreground">
            No probes in this section.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ProbeBadge(props: { status: string }) {
  return (
    <Badge
      variant={props.status === "fail" ? "destructive" : "outline"}
      className={cn(
        "px-2.5 py-1 capitalize",
        props.status === "pass"
          ? "border-success/30 bg-success/10 text-success"
          : "",
      )}
    >
      {props.status}
    </Badge>
  );
}
