import {
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  FastForward,
  Lightbulb,
  LockKeyhole,
  MessageSquareText,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isVerificationPassed,
  verificationStatusLabel,
} from "@/lib/verification-copy";
import { cn } from "@/lib/utils";
import type {
  WorkshopAgendaItem,
  WorkshopHealth,
  WorkshopModule,
  WorkshopModuleState,
} from "./types";
import { workshopModuleStateLabel } from "./types";

export function WorkshopAgendaRail({
  agenda,
  modules,
}: {
  agenda: WorkshopAgendaItem[];
  modules: WorkshopModule[];
}) {
  const moduleById = new Map(modules.map((module) => [module.id, module]));
  return (
    <section aria-labelledby="workshop-agenda-heading">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-eyebrow">Run of show</p>
          <h2 id="workshop-agenda-heading" className="mt-1 text-section-title">
            Agenda
          </h2>
        </div>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {agenda.reduce(
            (total, item) =>
              total + (item.scheduled ? item.durationMinutes : 0),
            0,
          )}{" "}
          min scheduled
        </span>
      </div>
      <ol className="overflow-hidden rounded-xl border bg-card">
        {agenda.map((item) => {
          const module = item.moduleId ? moduleById.get(item.moduleId) : null;
          const locked = !item.released;
          return (
            <li
              key={item.id}
              aria-current={item.active ? "step" : undefined}
              className={cn(
                "grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0 sm:grid-cols-[3rem_minmax(0,1fr)_auto] sm:px-4",
                item.active && "bg-brand-subtle",
                locked && "text-muted-foreground",
              )}
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {String(item.ordinal + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  {locked ? (
                    <LockKeyhole
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : module ? (
                    <ModuleStateGlyph
                      state={module.state}
                      health={module.health}
                    />
                  ) : item.completed ? (
                    <Check
                      className="size-3.5 text-success"
                      aria-hidden="true"
                    />
                  ) : (
                    <Clock3 className="size-3.5" aria-hidden="true" />
                  )}
                  <span className="truncate text-sm font-semibold">
                    {item.title}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground capitalize">
                  {item.kind.replace("_", " ")}
                  {module ? ` · ${module.tier}` : ""}
                  {!item.scheduled ? " · pre-session" : ""}
                </span>
              </span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {item.durationMinutes}m
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function WorkshopModuleManual({
  module,
  busy,
  onRevealHint,
  onCompleteExplainBack,
}: {
  module: WorkshopModule;
  busy: boolean;
  onRevealHint: (hintId: string) => void;
  onCompleteExplainBack: () => void;
}) {
  const passed = module.probes.filter((probe) =>
    isVerificationPassed(probe.status),
  ).length;
  const needsRepair = module.probes.length - passed;
  return (
    <section
      aria-labelledby="current-module-heading"
      className="divide-y rounded-xl border bg-card"
    >
      <div className="space-y-3 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-eyebrow">
              {module.tier} module · {module.durationMinutes} min
            </p>
            <h2 id="current-module-heading" className="mt-1 text-section-title">
              {module.title}
            </h2>
          </div>
          <Badge variant={moduleStateBadge(module.state)}>
            {workshopModuleStateLabel(module.state)}
          </Badge>
        </div>
        <div className="max-w-[68ch]">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Outcome
          </p>
          <p className="mt-1 text-body font-medium text-pretty">
            {module.outcome}
          </p>
        </div>
        {module.contentMarkdown ? (
          <Markdown className="max-w-[68ch]">{module.contentMarkdown}</Markdown>
        ) : null}
      </div>

      <div className="px-4 py-4 sm:px-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-eyebrow">Live verification</p>
          <div
            aria-label={`Verified: ${passed}; needs repair: ${needsRepair}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold tabular-nums"
          >
            <span className="inline-flex items-center gap-1 text-success">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              {passed} Verified
            </span>
            <span className="inline-flex items-center gap-1 text-destructive">
              <CircleAlert className="size-3.5" aria-hidden="true" />
              {needsRepair} Needs repair
            </span>
          </div>
        </div>
        {module.verificationUnavailable ? (
          <p
            role="status"
            className="mb-2 text-xs font-medium text-destructive"
          >
            Verification unavailable. We cannot confirm progress right now.
          </p>
        ) : null}
        {module.probes.length ? (
          <div className="divide-y">
            {module.probes.map((probe, probeIndex) => (
              <div
                key={probe.id}
                className="flex min-h-10 items-center gap-3 py-2 text-sm"
              >
                <ProbeGlyph status={probe.status} />
                <span className="min-w-0 flex-1 font-medium">
                  Verification objective {probeIndex + 1}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs font-semibold",
                    isVerificationPassed(probe.status)
                      ? "text-success"
                      : "text-destructive",
                  )}
                >
                  {verificationStatusLabel(probe.status)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Verification checks appear when the workspace is ready.
          </p>
        )}
      </div>

      {module.hints.length ? (
        <div className="px-4 py-4 sm:px-6">
          <p className="mb-1 text-eyebrow">Layered hints</p>
          <div className="divide-y">
            {module.hints.map((hint, index) => (
              <DisclosureRow
                key={hint.id}
                density="compact"
                leading={<Lightbulb className="size-4 text-warning" />}
                title={`Hint ${index + 1} · ${hint.title}`}
              >
                {hint.revealed && hint.bodyMarkdown ? (
                  <Markdown className="text-xs leading-6 text-muted-foreground">
                    {hint.bodyMarkdown}
                  </Markdown>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 py-1">
                    <p className="text-xs text-muted-foreground">
                      Reveal only when you need a smaller search space.
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRevealHint(hint.id)}
                    >
                      Reveal hint
                    </Button>
                  </div>
                )}
              </DisclosureRow>
            ))}
          </div>
        </div>
      ) : null}

      {module.explainBackPrompt ? (
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <MessageSquareText
              className="mt-0.5 size-4 shrink-0 text-brand-text"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold">Explain it back</p>
              <p className="max-w-[68ch] text-sm text-muted-foreground">
                {module.explainBackPrompt}
              </p>
            </div>
          </div>
          {module.explainBackCompletedAt ? (
            <Badge variant="success">Explained</Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onCompleteExplainBack}
            >
              Mark explained
            </Button>
          )}
        </div>
      ) : null}

      {module.solutionRevealed && module.solutionMarkdown ? (
        <div className="bg-muted/35 px-4 py-4 sm:px-6">
          <p className="mb-2 text-eyebrow">Facilitator walkthrough</p>
          <Markdown className="max-w-[68ch]">
            {module.solutionMarkdown}
          </Markdown>
        </div>
      ) : null}
    </section>
  );
}

export function ModuleStateGlyph({
  state,
  health,
  className,
}: {
  state: WorkshopModuleState;
  health: WorkshopHealth;
  className?: string;
}) {
  if (state === "verified" || state === "manually_completed") {
    return (
      <CheckCircle2
        aria-label={
          health === "failing" ? "Verified, now regressed" : "Verified"
        }
        className={cn(
          "size-4 shrink-0",
          health === "failing" ? "text-warning" : "text-success",
          className,
        )}
      />
    );
  }
  if (state === "caught_up") {
    return (
      <FastForward
        aria-label="Caught up from checkpoint"
        className={cn("size-4 shrink-0 text-brand-text", className)}
      />
    );
  }
  if (health === "failing") {
    return (
      <CircleAlert
        aria-label="Failing"
        className={cn("size-4 shrink-0 text-destructive", className)}
      />
    );
  }
  if (state === "locked") {
    return (
      <LockKeyhole
        aria-label="Locked"
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  return (
    <Circle
      aria-label={workshopModuleStateLabel(state)}
      className={cn(
        "size-4 shrink-0",
        state === "working"
          ? "fill-warning/20 text-warning"
          : "text-muted-foreground",
        className,
      )}
    />
  );
}

function ProbeGlyph({ status }: { status: string }) {
  if (isVerificationPassed(status)) {
    return (
      <CheckCircle2
        aria-hidden="true"
        className="size-4 shrink-0 text-success"
      />
    );
  }
  return (
    <CircleAlert
      aria-hidden="true"
      className="size-4 shrink-0 text-destructive"
    />
  );
}

function moduleStateBadge(state: WorkshopModuleState) {
  if (state === "verified" || state === "manually_completed") return "success";
  if (state === "working" || state === "available") return "warning";
  if (state === "caught_up") return "secondary";
  return "outline";
}
