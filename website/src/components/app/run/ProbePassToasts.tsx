import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { ScenarioObjective, ScenarioRunVmRecord } from "./run-types";

export interface ProbePassToast {
  id: string;
  label: string;
}

const TOAST_TTL_MS = 4_000;
const MAX_VISIBLE_TOASTS = 3;

// Watch the polled run data for scenario probes flipping to pass and emit
// short-lived toast entries. The first observation only seeds the baseline,
// so a page reload never replays old passes.
export function useProbePassEvents(
  vms: ScenarioRunVmRecord[] | undefined,
  objectives: ScenarioObjective[] | undefined,
  enabled: boolean,
): ProbePassToast[] {
  const [toasts, setToasts] = useState<ProbePassToast[]>([]);
  const seenRef = useRef<Map<string, string> | null>(null);
  const timersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id of timers) {
        window.clearTimeout(id);
      }
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      seenRef.current = null;
      setToasts([]);
      return;
    }

    const next = new Map<string, string>();
    for (const vm of vms ?? []) {
      for (const probe of vm.scenarioProbes) {
        next.set(`${vm.id}:${probe.id}`, probe.status);
      }
    }
    const previous = seenRef.current;
    seenRef.current = next;
    if (!previous) {
      return;
    }

    const fresh: ProbePassToast[] = [];
    for (const vm of vms ?? []) {
      for (const probe of vm.scenarioProbes) {
        const key = `${vm.id}:${probe.id}`;
        const before = previous.get(key);
        if (probe.status !== "pass" || before === undefined || before === "pass") {
          continue;
        }
        const objective = objectives?.find(
          (candidate) => candidate.probeName === probe.id,
        );
        fresh.push({
          id: `${key}:${Date.now()}`,
          label: objective?.title?.trim() || probe.label,
        });
      }
    }
    if (!fresh.length) {
      return;
    }

    setToasts((current) => [...current, ...fresh]);
    for (const toast of fresh) {
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer);
        setToasts((current) => current.filter((entry) => entry.id !== toast.id));
      }, TOAST_TTL_MS);
      timersRef.current.add(timer);
    }
  }, [vms, objectives, enabled]);

  return toasts;
}

// Peripheral confirmation near the terminal edge: the user is looking at the
// shell when a probe flips, not at the rail.
export function ProbePassToasts(props: { toasts: ProbePassToast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute right-4 bottom-4 z-10 flex flex-col gap-2"
    >
      {props.toasts.slice(-MAX_VISIBLE_TOASTS).map((toast) => (
        <div
          key={toast.id}
          className="flex items-center gap-2 rounded-lg border border-success/30 bg-card/95 px-3 py-2 text-sm shadow-md backdrop-blur motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2"
        >
          <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
          <span className="font-medium">{toast.label}</span>
          <span className="sr-only">check passing</span>
        </div>
      ))}
    </div>
  );
}
