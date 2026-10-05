import {
  SHARE_CHECKPOINT_SEGMENTS,
  SHARE_LIVE_ORIGIN,
  shareCheckpointPath,
  shareSegmentPath,
  type ShareHead,
  type SharedRunMission,
} from "./protocol";
import type { StoredShareMessage } from "./shared-run-model";

/**
 * Where the viewer stands with a share's files:
 * - live: the head is read, and every segment it names is applied
 * - recorded: the same, but the share was rebuilt from the run's recordings,
 *   so nothing is live anymore
 * - reconnecting: a read failed (the network, a 5xx, a rate limit); it tries again
 * - stopped: the files are gone (a 404), so the share was stopped or never was
 * - unavailable: reads kept failing; it gave up until the viewer tries again
 */
export type ShareLiveStatus =
  | "live"
  | "recorded"
  | "reconnecting"
  | "stopped"
  | "unavailable";

export const SHARE_POLL_INTERVAL_MS = 1_000;
/**
 * A recorded share does not change, so the head is only read to hear that the
 * learner stopped sharing.
 */
export const SHARE_RECORDED_POLL_INTERVAL_MS = 30_000;
export const SHARE_RETRY_MIN_MS = 1_000;
export const SHARE_RETRY_MAX_MS = 30_000;
/** Failed reads in a row before the share is called unavailable: with the backoff, about half a minute. */
export const SHARE_FAILURES_BEFORE_UNAVAILABLE = 6;
/** A viewer catching up on a long share asks for this many files at a time. */
export const SHARE_SEGMENT_PARALLELISM = 4;
/** A read that has not finished by now has hung, and counts as a failure. */
export const SHARE_REQUEST_TIMEOUT_MS = 15_000;
const JITTER = 0.3;

/** One second doubling to thirty, each spread by 30% either way. */
export function shareRetryDelay(attempt: number, random: number): number {
  const base = Math.min(SHARE_RETRY_MAX_MS, SHARE_RETRY_MIN_MS * 2 ** attempt);
  return Math.round(base * (1 + (random * 2 - 1) * JITTER));
}

/** `<origin>/<share id>/<file>`; the share id is the capability, so it is the path. */
export function shareLiveUrl(
  origin: string,
  shareId: string,
  file: string,
): string {
  return `${origin.replace(/\/+$/, "")}/${shareId}/${file}`;
}

/**
 * A segment's messages, in order. A line that is not a message is skipped
 * rather than costing the viewer the rest of the segment.
 */
export function parseShareSegment(text: string): StoredShareMessage[] {
  const messages: StoredShareMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { type?: unknown }).type === "string"
      ) {
        messages.push(value as StoredShareMessage);
      }
    } catch {
      // Not JSON: nothing to apply from this line.
    }
  }
  return messages;
}

/** One file to read, and the newest segment the messages in it reach. */
export interface ShareFetch {
  path: string;
  through: number;
}

/**
 * The files that bring a viewer who holds segments 1 to `applied` of a
 * generation up to its head. A checkpoint is a run of
 * `SHARE_CHECKPOINT_SEGMENTS` segments in one file, so a viewer far behind
 * (one who has just joined, or woke up after a long while) reads a few of
 * those instead of hundreds of segments. It reads a checkpoint only when it
 * holds nothing of what is in it, so nothing it has is read twice: segments up
 * to the next checkpoint's start, then whole checkpoints, then the segments
 * after the last of them. A viewer keeping up is never that far behind, and
 * reads segments only.
 */
export function shareFetchPlan(
  generation: number,
  applied: number,
  head: Pick<ShareHead, "segment" | "checkpoint">,
): ShareFetch[] {
  const size = SHARE_CHECKPOINT_SEGMENTS;
  // The head's count is trusted as far as its segments support it.
  const complete = Math.min(
    Math.max(0, Math.floor(head.checkpoint)),
    Math.floor(head.segment / size),
  );
  // The first checkpoint that starts after everything the viewer holds.
  const first = Math.ceil(applied / size) + 1;
  const plan: ShareFetch[] = [];
  const segments = (from: number, to: number) => {
    for (let segment = from; segment <= to; segment += 1) {
      plan.push({
        path: shareSegmentPath(generation, segment),
        through: segment,
      });
    }
  };
  if (first > complete) {
    segments(applied + 1, head.segment);
    return plan;
  }
  segments(applied + 1, (first - 1) * size);
  for (let checkpoint = first; checkpoint <= complete; checkpoint += 1) {
    plan.push({
      path: shareCheckpointPath(generation, checkpoint),
      through: checkpoint * size,
    });
  }
  segments(complete * size + 1, head.segment);
  return plan;
}

function count(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function parseHead(text: string): ShareHead {
  const value = JSON.parse(text) as Partial<ShareHead> | null;
  if (!value || !count(value.generation, 1) || !count(value.segment, 0)) {
    throw new Error("unreadable head");
  }
  return {
    generation: value.generation,
    segment: value.segment,
    // A head that says nothing of checkpoints has none to offer.
    checkpoint: count(value.checkpoint, 0) ? value.checkpoint : 0,
    seq: typeof value.seq === "number" ? value.seq : 0,
    truncated: value.truncated === true,
    recorded: value.recorded === true,
  };
}

/** The page draws every part of the mission, so a part that is missing is made empty. */
function parseMission(text: string): SharedRunMission {
  const value = JSON.parse(text) as Partial<SharedRunMission> | null;
  if (!value || typeof value.title !== "string") {
    throw new Error("unreadable mission");
  }
  return {
    title: value.title,
    tagline: typeof value.tagline === "string" ? value.tagline : "",
    scenario_name:
      typeof value.scenario_name === "string" ? value.scenario_name : "",
    lecture_title:
      typeof value.lecture_title === "string" ? value.lecture_title : null,
    markdown: typeof value.markdown === "string" ? value.markdown : "",
    objectives: Array.isArray(value.objectives) ? value.objectives : [],
    vms: Array.isArray(value.vms) ? value.vms : [],
  };
}

export interface ShareLiveOptions {
  shareId: string;
  /** Where the share's files are served from; the CDN. */
  origin?: string;
  fetch?: typeof fetch;
  random?: () => number;
  requestTimeoutMs?: number;
  /** Once, when the mission has been read. */
  onMission: (mission: SharedRunMission) => void;
  /**
   * The generation whose segments follow: said before the first of them (or,
   * for a generation with none, once it is read), the first time and each time
   * the share is rebuilt. A viewer drops what it holds from an earlier one.
   */
  onGeneration: (generation: number) => void;
  /** Each time the head is read, after what it names has been delivered. */
  onHead: (head: ShareHead) => void;
  /**
   * One file's messages (a segment, or a checkpoint of many), each file once
   * and in order.
   */
  onMessages: (messages: StoredShareMessage[]) => void;
  /** Only when the status changes. */
  onStatus: (status: ShareLiveStatus) => void;
}

export interface ShareLive {
  /** Reads again now, with the count of failures started over. */
  retry(): void;
  close(): void;
}

/** The head or the mission answered 404: the share is not there. */
class ShareGone extends Error {}

/**
 * A segment or checkpoint the head names answered 404. The share may have been
 * rebuilt since the head was read, which deletes the old generation's files,
 * so this is a reason to read the head again, not yet a reason to call the
 * share stopped.
 */
class SegmentGone extends Error {}

const noop = () => undefined;

/**
 * Follows a share by reading its files: the mission once, then the head every
 * second, and each segment the head names that has not been applied yet.
 * Segments are immutable and arrive in order, so a viewer who has been here
 * since the start reads only the new one. One who joins a long share reads its
 * checkpoints and the segments after them (a few files at a time, applied in
 * order), and one who falls far behind does the same from where it is. The
 * viewer count costs the share nothing, since the CDN answers every read.
 *
 * A 404 on the head or the mission means the share was stopped. A 404 on a
 * segment or a checkpoint sends the viewer back to the head, which tells
 * whether the share was rebuilt meanwhile (a new generation, read from its
 * first segment). Any other
 * failed read is retried with a jittered backoff, and a run of them without
 * progress is called unavailable.
 */
export function startShareLive(options: ShareLiveOptions): ShareLive {
  const origin = options.origin ?? SHARE_LIVE_ORIGIN;
  const random = options.random ?? Math.random;
  const timeoutMs = options.requestTimeoutMs ?? SHARE_REQUEST_TIMEOUT_MS;
  const doFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const closing = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let closed = false;
  let status: ShareLiveStatus | null = null;
  let failures = 0;
  let loaded = false;
  /** The generation being read, and whether the viewer was told of it. */
  let generation = 0;
  let announced = false;
  /** The newest segment of that generation delivered. */
  let applied = 0;

  const say = (next: ShareLiveStatus) => {
    if (closed || next === status) return;
    status = next;
    options.onStatus(next);
  };

  async function request(file: string, init: RequestInit = {}): Promise<string> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = AbortSignal.timeout(timeoutMs);
    closing.signal.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
    try {
      const response = await doFetch(
        shareLiveUrl(origin, options.shareId, file),
        { ...init, signal: controller.signal },
      );
      if (response.status === 404) throw new ShareGone();
      if (!response.ok) {
        throw new Error(`the share's files answered ${response.status}`);
      }
      return await response.text();
    } finally {
      closing.signal.removeEventListener("abort", abort);
      timeout.removeEventListener("abort", abort);
    }
  }

  function announce(): void {
    if (announced) return;
    announced = true;
    options.onGeneration(generation);
  }

  /** Delivers the files of a plan, a few requested ahead, always in order. */
  async function deliver(plan: readonly ShareFetch[]): Promise<void> {
    const pending = new Map<number, Promise<string>>();
    for (let index = 0; index < plan.length; index += 1) {
      const window = Math.min(plan.length - 1, index + SHARE_SEGMENT_PARALLELISM - 1);
      for (let ahead = index; ahead <= window; ahead += 1) {
        if (pending.has(ahead)) continue;
        const read = request(plan[ahead]!.path);
        // One that is not awaited yet must not be an unhandled rejection.
        read.catch(noop);
        pending.set(ahead, read);
      }
      let text: string;
      try {
        text = await pending.get(index)!;
      } catch (error) {
        throw error instanceof ShareGone ? new SegmentGone() : error;
      }
      pending.delete(index);
      if (closed) return;
      // The first file of a generation replaces the old log in the same
      // breath, so a viewer never sees the share empty in between.
      announce();
      options.onMessages(parseShareSegment(text));
      applied = plan[index]!.through;
      // Progress is not a failure: a viewer catching up over a poor connection
      // keeps going for as long as each try gets further than the last.
      failures = 0;
    }
  }

  async function readHead(): Promise<ShareHead> {
    return parseHead(await request("head.json", { cache: "no-cache" }));
  }

  /** One round: the head, the mission once, and what the head names. */
  async function read(): Promise<ShareHead> {
    const headRead = readHead();
    const missionRead = loaded ? null : request("mission.json");
    headRead.catch(noop);
    missionRead?.catch(noop);
    let head = await headRead;
    if (closed) return head;
    if (missionRead) {
      const mission = parseMission(await missionRead);
      if (closed) return head;
      options.onMission(mission);
      loaded = true;
    }
    for (let looks = 1; ; looks += 1) {
      if (head.generation !== generation) {
        // Rebuilt from the recordings: read the new log from its first segment.
        generation = head.generation;
        applied = 0;
        announced = false;
      }
      try {
        await deliver(shareFetchPlan(generation, applied, head));
        break;
      } catch (error) {
        if (!(error instanceof SegmentGone)) throw error;
        // Gone from a generation that is still the head's is a share being
        // deleted, or a file that is missing: a failed read.
        const next = looks < 3 ? await readHead() : head;
        if (closed || next.generation === head.generation) {
          throw new Error("a segment the head names is missing");
        }
        head = next;
      }
    }
    if (closed) return head;
    // A generation with no segment is still the one the viewer is on.
    announce();
    options.onHead(head);
    return head;
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  }

  async function run(): Promise<void> {
    running = true;
    try {
      const head = await read();
      if (closed) return;
      failures = 0;
      say(head.recorded ? "recorded" : "live");
      schedule(
        head.recorded ? SHARE_RECORDED_POLL_INTERVAL_MS : SHARE_POLL_INTERVAL_MS,
      );
    } catch (error) {
      if (closed) return;
      if (error instanceof ShareGone) {
        say("stopped");
        return;
      }
      failures += 1;
      if (failures >= SHARE_FAILURES_BEFORE_UNAVAILABLE) {
        say("unavailable");
        return;
      }
      say("reconnecting");
      schedule(shareRetryDelay(failures - 1, random()));
    } finally {
      running = false;
    }
  }

  void run();

  return {
    retry() {
      // A read in flight will say how it went.
      if (closed || running) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      failures = 0;
      // Said again even if it comes out the same, so the page hears the answer.
      status = null;
      void run();
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      closing.abort();
    },
  };
}
