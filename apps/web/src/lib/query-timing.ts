import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Temporary. Logs every database query a start request and a host wake make,
 * with when each began and how long it took, to find where a lab start
 * spends its first two seconds. Removed with the fix.
 */
interface Timing {
  startedAt: number;
  entries: Array<[label: string, atMs: number, tookMs: number]>;
}

const timings = new AsyncLocalStorage<Timing>();
let patched = false;

function wrap(proto: object, method: string, label: (self: unknown, args: unknown[]) => string): void {
  const target = proto as Record<string, unknown>;
  const original = target[method];
  if (typeof original !== "function") return;
  target[method] = function (this: unknown, ...args: unknown[]): unknown {
    const timing = timings.getStore();
    const result: unknown = Reflect.apply(original, this, args);
    if (!timing || !(result instanceof Promise)) return result;
    const began = Date.now();
    const record = (): void => {
      timing.entries.push([label(this, args), began - timing.startedAt, Date.now() - began]);
    };
    void result.then(record, record);
    return result;
  };
}

function sqlOf(statement: unknown): string {
  const text = (statement as { statement?: unknown } | null)?.statement;
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 80) : "?";
}

async function patch(): Promise<void> {
  if (patched) return;
  patched = true;
  try {
    // Imported here: the Node test runner cannot resolve this module.
    const { env } = await import("cloudflare:workers");
    wrap(Object.getPrototypeOf(env.DB) as object, "batch", (_self, args) => {
      const statements = Array.isArray(args[0]) ? args[0] : [];
      return `batch(${String(statements.length)}) ${statements.slice(0, 3).map(sqlOf).join(" | ")}`;
    });
    const statementProto = Object.getPrototypeOf(env.DB.prepare("SELECT 1")) as object;
    for (const method of ["first", "run", "all", "raw"]) wrap(statementProto, method, (self) => sqlOf(self));
  } catch {
    // Diagnostics only.
  }
}

/** Adds a mark to the timing of the request this runs under, if any. */
export function markTiming(label: string): void {
  const timing = timings.getStore();
  if (timing) timing.entries.push([`# ${label}`, Date.now() - timing.startedAt, 0]);
}

/**
 * Runs `operation` and logs its queries. With `defer`, the line is written
 * later, so it also holds what the request left running in the background.
 */
export async function withQueryTiming<T>(
  name: string,
  operation: () => Promise<T>,
  defer?: (log: () => void) => void,
): Promise<T> {
  await patch();
  const timing: Timing = { startedAt: Date.now(), entries: [] };
  const log = (): void => {
    console.info(JSON.stringify({
      event: "query_timing", name, startedAt: timing.startedAt,
      entries: [...timing.entries].sort((left, right) => left[1] - right[1]),
    }));
  };
  try {
    return await timings.run(timing, operation);
  } finally {
    markTiming("returned");
    if (defer) defer(log);
    else log();
  }
}
