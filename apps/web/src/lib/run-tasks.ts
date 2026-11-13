import type { CheckStatus, VmTaskV1 } from "@/generated/contracts/bridge-message-v9";
import type { RevisionTaskV1 } from "@/generated/contracts/scenario-revision-v1";

/** One task of a run on the revision model, as its guest last reported it. */
export interface RunTaskState {
  id: string;
  title: string;
  machine: string;
  needs: string[];
  optional: boolean;
  ordinal: number;
  status: CheckStatus;
  message: string;
  /** Set by the first pass and never cleared: a pass latches. */
  passedAt: number | null;
}

/** What a learner sees of a task. */
export interface RunTaskView {
  id: string;
  title: string;
  machine: string;
  optional: boolean;
  status: CheckStatus;
  message: string;
  available: boolean;
  complete: boolean;
}

/** The text a learner sees when a guest reports its lab failed. */
export const LAB_FAILED_TEXT =
  "The lab could not be prepared. Start the scenario again; if it keeps failing, contact support.";

const MAX_TASK_MESSAGE_CHARS = 512;

/** A VM's lab as a learner may see it: the guest's failure text is admin-only. */
export function learnerLab<T extends { failure: string | null }>(lab: T | null | undefined): T | null {
  return lab ? { ...lab, failure: null } : null;
}

export function initialRunTasks(tasks: readonly RevisionTaskV1[]): RunTaskState[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    machine: task.machine,
    needs: [...task.needs],
    optional: task.optional,
    ordinal: task.ordinal,
    status: "pending",
    message: "",
    passedAt: null,
  }));
}

/**
 * Merges one machine's reported tasks. Only tasks the run defines for that
 * machine move; a passed task keeps its pass whatever comes later.
 */
export function mergeReportedTasks(
  tasks: readonly RunTaskState[],
  machine: string,
  reported: readonly VmTaskV1[],
  nowUnixMs: number,
): RunTaskState[] {
  const byId = new Map(reported.map((task) => [task.id, task]));
  return tasks.map((task) => {
    const next = task.machine === machine ? byId.get(task.id) : undefined;
    if (!next || task.passedAt !== null) return task;
    return {
      ...task,
      status: next.status,
      message: next.message.slice(0, MAX_TASK_MESSAGE_CHARS),
      passedAt: next.status === "pass" ? next.passed_at_unix_ms ?? nowUnixMs : null,
    };
  });
}

/**
 * A task is available when every task it needs is complete, on any machine,
 * and complete when it is available and has passed. A need on an unknown
 * task or a cycle is never complete.
 */
export function taskViews(tasks: readonly RunTaskState[]): RunTaskView[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const complete = new Map<string, boolean>();
  const visiting = new Set<string>();
  const available = (task: RunTaskState): boolean => task.needs.every(isComplete);
  function isComplete(id: string): boolean {
    const known = complete.get(id);
    if (known !== undefined) return known;
    const task = byId.get(id);
    if (!task || visiting.has(id)) return false;
    visiting.add(id);
    const result = task.passedAt !== null && available(task);
    visiting.delete(id);
    complete.set(id, result);
    return result;
  }
  return [...tasks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((task) => ({
      id: task.id,
      title: task.title,
      machine: task.machine,
      optional: task.optional,
      status: task.passedAt !== null ? "pass" : task.status,
      message: task.message,
      available: available(task),
      complete: isComplete(task.id),
    }));
}

/** Solved: every non-optional task is complete, and there is at least one. */
export function tasksSolved(tasks: readonly RunTaskState[]): boolean {
  const required = taskViews(tasks).filter((task) => !task.optional);
  return required.length > 0 && required.every((task) => task.complete);
}
