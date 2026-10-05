import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHARE_CHECKPOINT_SEGMENTS,
  SHARE_LIVE_ORIGIN,
  type ShareHead,
  type SharedRunMission,
} from "./protocol";
import type { StoredShareMessage } from "./shared-run-model";
import {
  SHARE_FAILURES_BEFORE_UNAVAILABLE,
  SHARE_POLL_INTERVAL_MS,
  SHARE_RECORDED_POLL_INTERVAL_MS,
  SHARE_SEGMENT_PARALLELISM,
  parseShareSegment,
  shareFetchPlan,
  shareLiveUrl,
  shareRetryDelay,
  startShareLive,
  type ShareLiveOptions,
  type ShareLiveStatus,
} from "./shared-run-poller";

const SHARE_ID = "Zm9vYmFyYmF6cXV4cXV1eA";
const ORIGIN = "https://live.example.test";

const mission: SharedRunMission = {
  title: "Repair a broken nginx service",
  tagline: "Bring the website back online.",
  scenario_name: "repair-nginx",
  lecture_title: "Service recovery",
  markdown: "## Service recovery",
  objectives: [],
  vms: [{ id: "vm_web", name: "web" }],
};

/** One stored message; `seq` is the row it has in its generation's log. */
const row = (seq: number) => ({
  type: "events",
  seq,
  session: "a",
  events: [[seq, "o", `row ${seq}`]],
});

/** A fetch that never answers until it is released, and gives up when aborted. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject);
  });
}

const FIRST_HEAD: ShareHead = {
  generation: 1,
  segment: 0,
  checkpoint: 0,
  seq: 0,
  truncated: false,
  recorded: false,
};

/** The share's files on the CDN, and what has been asked of them. */
class Cdn {
  mission: unknown = mission;
  head: ShareHead | null = { ...FIRST_HEAD };
  /** Segment files by path, `g1/1.jsonl`; one that is not here is a 404. */
  files = new Map<string, string>();
  /** Files that answer with this status instead of their content. */
  statuses = new Map<string, number>();
  /** Files whose read fails the way a dropped network does. */
  broken = new Set<string>();
  private holds = new Map<string, Promise<void>>();
  requests: Array<{ url: string; file: string; init: RequestInit | undefined }> =
    [];

  /**
   * Appends a segment to the current generation and moves the head to it. As
   * the share's writer does, each time a run of segments is complete it also
   * writes them as one checkpoint, before the head names it.
   */
  publish(...lines: object[]): void {
    const head = this.head ?? { ...FIRST_HEAD };
    const segment = head.segment + 1;
    this.files.set(
      `g${head.generation}/${segment}.jsonl`,
      lines.map((line) => JSON.stringify(line)).join("\n"),
    );
    let checkpoint = head.checkpoint;
    if (segment % SHARE_CHECKPOINT_SEGMENTS === 0) {
      checkpoint = segment / SHARE_CHECKPOINT_SEGMENTS;
      const first = segment - SHARE_CHECKPOINT_SEGMENTS + 1;
      this.files.set(
        `g${head.generation}/c${checkpoint}.jsonl`,
        Array.from(
          { length: SHARE_CHECKPOINT_SEGMENTS },
          (_, index) => this.files.get(`g${head.generation}/${first + index}.jsonl`),
        ).join("\n"),
      );
    }
    this.head = { ...head, segment, checkpoint };
  }

  /** Segments 1 to `count`, each holding one row whose seq is its number. */
  publishRows(count: number): void {
    for (let segment = this.head?.segment ?? 0; segment < count; segment += 1) {
      this.publish(row(segment + 1));
    }
  }

  /**
   * The run's archive is ready: the share is republished from the recordings as
   * the next generation, and the old generation's files are deleted.
   */
  rebuild(segments: object[][], recorded = true): void {
    const old = this.head?.generation ?? 1;
    // The old generation's files, checkpoints too, are deleted.
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`g${old}/`)) this.files.delete(path);
    }
    const generation = old + 1;
    segments.forEach((lines, index) => {
      this.files.set(
        `g${generation}/${index + 1}.jsonl`,
        lines.map((line) => JSON.stringify(line)).join("\n"),
      );
    });
    // A rebuilt share is small, and read from its segments.
    this.head = {
      generation,
      segment: segments.length,
      checkpoint: 0,
      seq: 0,
      truncated: false,
      recorded,
    };
  }

  /** The answer for `file` waits until the returned function is called. */
  hold(file: string): () => void {
    let release!: () => void;
    this.holds.set(
      file,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  count(file: string): number {
    return this.requests.filter((request) => request.file === file).length;
  }

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const file = new URL(url).pathname.split("/").slice(2).join("/");
    this.requests.push({ url, file, init });
    const hold = this.holds.get(file);
    if (hold) await abortable(hold, init?.signal);
    if (this.broken.has(file)) throw new TypeError("Failed to fetch");
    const status = this.statuses.get(file);
    if (status) return new Response("", { status });
    const body = this.content(file);
    return body === null
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  };

  private content(file: string): string | null {
    if (file === "head.json") return this.head && JSON.stringify(this.head);
    if (file === "mission.json") {
      return this.mission === null ? null : JSON.stringify(this.mission);
    }
    return this.files.get(file) ?? null;
  }
}

function follow(cdn: Cdn, extra: Partial<ShareLiveOptions> = {}) {
  const missions: SharedRunMission[] = [];
  const generations: number[] = [];
  const heads: ShareHead[] = [];
  const segments: StoredShareMessage[][] = [];
  const statuses: ShareLiveStatus[] = [];
  /** What the viewer was told, in the order it was told. */
  const told: string[] = [];
  const live = startShareLive({
    shareId: SHARE_ID,
    origin: ORIGIN,
    fetch: cdn.fetch as typeof fetch,
    // The middle of the jitter, so a delay is its base.
    random: () => 0.5,
    onMission: (value) => {
      missions.push(value);
      told.push("mission");
    },
    onGeneration: (value) => {
      generations.push(value);
      told.push(`generation ${value}`);
    },
    onHead: (value) => {
      heads.push(value);
      told.push("head");
    },
    onMessages: (value) => {
      segments.push(value);
      told.push(`segment ${value.map((message) => message.seq).join(",")}`);
    },
    onStatus: (value) => statuses.push(value),
    ...extra,
  });
  return { live, missions, generations, heads, segments, statuses, told };
}

/** Lets what has been asked for come back, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const headRequest = (cdn: Cdn) =>
  cdn.requests.find((request) => request.file === "head.json");
const seqs = (segments: StoredShareMessage[][]) =>
  segments.map((segment) => segment.map((message) => message.seq));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading a share", () => {
  it("reads the mission and the head, then every segment in order, and is live", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    cdn.publish(row(3));
    const run = follow(cdn);
    await settle();

    expect(run.missions).toEqual([mission]);
    expect(run.heads).toEqual([{ ...FIRST_HEAD, segment: 3 }]);
    expect(seqs(run.segments)).toEqual([[1], [2], [3]]);
    expect(run.statuses).toEqual(["live"]);
    expect(cdn.requests.map((request) => request.url).sort()).toEqual(
      ["head.json", "mission.json", "g1/1.jsonl", "g1/2.jsonl", "g1/3.jsonl"]
        .map((file) => `${ORIGIN}/${SHARE_ID}/${file}`)
        .sort(),
    );
    // The head is asked for first.
    expect(cdn.requests[0]?.file).toBe("head.json");
    run.live.close();
  });

  it("tells the viewer the generation before its first segment, and the head after the last", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    const run = follow(cdn);
    await settle();

    expect(run.told).toEqual([
      "mission",
      "generation 1",
      "segment 1",
      "segment 2",
      "head",
    ]);
    run.live.close();
  });

  it("asks the head to be revalidated, and nothing else", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();

    const cacheOf = (file: string) =>
      cdn.requests.find((request) => request.file === file)?.init?.cache;
    expect(cacheOf("head.json")).toBe("no-cache");
    // The mission and the segments never change, so the cache may keep them.
    expect(cacheOf("mission.json")).toBeUndefined();
    expect(cacheOf("g1/1.jsonl")).toBeUndefined();
    run.live.close();
  });

  it("reads from the live origin by default, with the share id as the path", async () => {
    const cdn = new Cdn();
    const run = follow(cdn, {
      origin: undefined as unknown as string,
    });
    await settle();

    expect(cdn.requests.map((request) => request.url).sort()).toEqual([
      shareLiveUrl(SHARE_LIVE_ORIGIN, SHARE_ID, "head.json"),
      shareLiveUrl(SHARE_LIVE_ORIGIN, SHARE_ID, "mission.json"),
    ]);
    expect(SHARE_LIVE_ORIGIN).toMatch(/^https:\/\//);
    run.live.close();
  });

  it("is live on a share that has no segment yet, and still tells the generation", async () => {
    const cdn = new Cdn();
    const run = follow(cdn);
    await settle();

    expect(run.missions).toEqual([mission]);
    expect(run.segments).toEqual([]);
    expect(run.statuses).toEqual(["live"]);
    expect(run.told).toEqual(["mission", "generation 1", "head"]);
    expect(
      cdn.requests.some((request) => request.file.startsWith("g1/")),
    ).toBe(false);
    run.live.close();
  });

  it("hands over the head each time it is read, with its truncation flag", async () => {
    const cdn = new Cdn();
    cdn.head = { ...FIRST_HEAD, truncated: true };
    const run = follow(cdn);
    await settle();
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(run.heads.map((head) => head.truncated)).toEqual([true, true]);
    // The generation is told once, not with every head.
    expect(run.generations).toEqual([1]);
    run.live.close();
  });

  it("applies segments in order even when later ones come back first", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    cdn.publish(row(3));
    const releaseFirst = cdn.hold("g1/1.jsonl");
    const run = follow(cdn);
    await settle();

    // The second and third were asked for alongside the first, and are back.
    expect(cdn.count("g1/2.jsonl")).toBe(1);
    expect(cdn.count("g1/3.jsonl")).toBe(1);
    expect(run.segments).toEqual([]);
    expect(run.statuses).toEqual([]);

    releaseFirst();
    await settle();
    expect(seqs(run.segments)).toEqual([[1], [2], [3]]);
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });

  it("asks for only a few segments at a time", async () => {
    const cdn = new Cdn();
    const releases: Array<() => void> = [];
    for (let segment = 1; segment <= 10; segment += 1) {
      cdn.publish(row(segment));
      releases.push(cdn.hold(`g1/${segment}.jsonl`));
    }
    const run = follow(cdn);
    await settle();

    const asked = () =>
      cdn.requests
        .filter((request) => request.file.startsWith("g1/"))
        .map((request) => request.file);
    expect(SHARE_SEGMENT_PARALLELISM).toBe(4);
    expect(asked()).toEqual([1, 2, 3, 4].map((n) => `g1/${n}.jsonl`));

    // Each one that is applied lets the next be asked for.
    releases[0]!();
    await settle();
    expect(asked()).toHaveLength(5);
    expect(seqs(run.segments)).toEqual([[1]]);

    for (const release of releases) release();
    await settle();
    expect(seqs(run.segments)).toEqual(
      Array.from({ length: 10 }, (_, index) => [index + 1]),
    );
    expect(asked()).toHaveLength(10);
    run.live.close();
  });

  it("polls the head every second and reads only the segment that is new", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();
    expect(cdn.count("head.json")).toBe(1);

    await tick(SHARE_POLL_INTERVAL_MS - 1);
    expect(cdn.count("head.json")).toBe(1);
    await tick(1);
    expect(cdn.count("head.json")).toBe(2);
    // Nothing is new: no segment and no mission is read again.
    expect(cdn.count("g1/1.jsonl")).toBe(1);
    expect(cdn.count("mission.json")).toBe(1);

    cdn.publish(row(2));
    await tick(SHARE_POLL_INTERVAL_MS);
    expect(seqs(run.segments)).toEqual([[1], [2]]);
    expect(cdn.count("g1/1.jsonl")).toBe(1);
    expect(cdn.count("g1/2.jsonl")).toBe(1);
    expect(run.missions).toHaveLength(1);
    // Said once: it stays live.
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });

  it("reads a segment that is new while it is still catching up on the rest, in order", async () => {
    const cdn = new Cdn();
    for (let segment = 1; segment <= 6; segment += 1) cdn.publish(row(segment));
    const run = follow(cdn);
    await settle();
    cdn.publish(row(7));
    cdn.publish(row(8));
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(seqs(run.segments)).toEqual(
      Array.from({ length: 8 }, (_, index) => [index + 1]),
    );
    run.live.close();
  });

  it("does nothing when the head goes back within a generation", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    const run = follow(cdn);
    await settle();
    cdn.head = { ...FIRST_HEAD, segment: 1, seq: 1 };
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(seqs(run.segments)).toEqual([[1], [2]]);
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });

  it("makes a mission with parts missing complete, and refuses one with no title", async () => {
    const cdn = new Cdn();
    cdn.mission = { title: "Only a title" };
    const run = follow(cdn);
    await settle();

    expect(run.missions).toEqual([
      {
        title: "Only a title",
        tagline: "",
        scenario_name: "",
        lecture_title: null,
        markdown: "",
        objectives: [],
        vms: [],
      },
    ]);
    run.live.close();

    const broken = new Cdn();
    broken.mission = { tagline: "no title" };
    const other = follow(broken);
    await settle();
    expect(other.missions).toEqual([]);
    expect(other.statuses).toEqual(["reconnecting"]);
    other.live.close();
  });

  it.each([
    ["a segment that is not a number", { ...FIRST_HEAD, segment: "3" }],
    ["no generation", { segment: 0, seq: 0, truncated: false, recorded: false }],
    ["a generation of 0", { ...FIRST_HEAD, generation: 0 }],
  ])("treats a head with %s as a failed read", async (_name, head) => {
    const cdn = new Cdn();
    cdn.head = head as unknown as ShareHead;
    const run = follow(cdn);
    await settle();

    expect(run.statuses).toEqual(["reconnecting"]);
    expect(run.segments).toEqual([]);
    run.live.close();
  });
});

/** The files a read asked for, by name, in the order it asked. */
const asked = (cdn: Cdn) =>
  cdn.requests
    .map((request) => request.file)
    .filter((file) => file.startsWith("g"));
const segmentFiles = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `g1/${from + index}.jsonl`);

describe("a viewer far behind", () => {
  const N = SHARE_CHECKPOINT_SEGMENTS;

  it("joins a share at segment 150 through checkpoints 1 and 2, then reads segments 121 to 150", async () => {
    const cdn = new Cdn();
    cdn.publishRows(150);
    expect(cdn.head).toMatchObject({ segment: 150, checkpoint: 2 });
    const run = follow(cdn);
    await settle();

    // Two checkpoints, then the thirty segments after them: no segment before
    // the second checkpoint's end is read on its own.
    expect([...asked(cdn)].sort()).toEqual(
      ["g1/c1.jsonl", "g1/c2.jsonl", ...segmentFiles(121, 150)].sort(),
    );
    // Applied in order: the checkpoints' rows (1 to 60, 61 to 120), then each segment.
    expect(run.segments.map((batch) => batch.length)).toEqual([
      60,
      60,
      ...Array.from({ length: 30 }, () => 1),
    ]);
    expect(run.segments.flat().map((message) => message.seq)).toEqual(
      Array.from({ length: 150 }, (_, index) => index + 1),
    );
    expect(run.statuses).toEqual(["live"]);
    expect(run.generations).toEqual([1]);
    run.live.close();
  });

  it("asks for the checkpoints in order, a few at a time, and applies them in order", async () => {
    const cdn = new Cdn();
    cdn.publishRows(5 * N);
    const releases = [1, 2, 3, 4, 5].map((k) => cdn.hold(`g1/c${k}.jsonl`));
    const run = follow(cdn);
    await settle();

    expect(asked(cdn)).toEqual([1, 2, 3, 4].map((k) => `g1/c${k}.jsonl`));
    // The third is back before the first: nothing is applied out of order.
    releases[2]!();
    releases[1]!();
    await settle();
    expect(run.segments).toEqual([]);
    releases[0]!();
    await settle();
    expect(asked(cdn)).toHaveLength(5);
    expect(run.segments.map((batch) => batch[0]?.seq)).toEqual([
      1,
      N + 1,
      2 * N + 1,
    ]);
    for (const release of releases) release();
    await settle();
    expect(run.segments.map((batch) => batch[0]?.seq)).toEqual(
      [0, 1, 2, 3, 4].map((k) => k * N + 1),
    );
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });

  it("reads no checkpoint when the share has not completed one", async () => {
    const cdn = new Cdn();
    cdn.publishRows(N - 1);
    const run = follow(cdn);
    await settle();

    expect(asked(cdn)).toEqual(segmentFiles(1, N - 1));
    expect(cdn.head?.checkpoint).toBe(0);
    run.live.close();
  });

  it("reads a checkpoint the moment it is complete, as the share's very last segment", async () => {
    const cdn = new Cdn();
    cdn.publishRows(N);
    const run = follow(cdn);
    await settle();

    // One checkpoint and nothing after it.
    expect(asked(cdn)).toEqual(["g1/c1.jsonl"]);
    expect(run.segments.flat().map((message) => message.seq)).toEqual(
      Array.from({ length: N }, (_, index) => index + 1),
    );
    run.live.close();
  });

  it("does not fetch a checkpoint while it follows, and never reads a segment twice", async () => {
    const cdn = new Cdn();
    cdn.publishRows(10);
    const run = follow(cdn);
    await settle();

    // It keeps up for the minute and a half in which the first checkpoint
    // is completed and a second is begun.
    for (let segment = 11; segment <= N + 30; segment += 1) {
      cdn.publishRows(segment);
      await tick(SHARE_POLL_INTERVAL_MS);
    }

    expect(cdn.head).toMatchObject({ segment: N + 30, checkpoint: 1 });
    expect(asked(cdn)).toEqual(segmentFiles(1, N + 30));
    expect(run.segments.flat().map((message) => message.seq)).toEqual(
      Array.from({ length: N + 30 }, (_, index) => index + 1),
    );
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });

  it("reads segments to the next checkpoint, then checkpoints it holds nothing of, then the tail", async () => {
    const cdn = new Cdn();
    cdn.publishRows(70);
    const run = follow(cdn);
    await settle();
    // Read individually so far: segments 1 to 70, which is part of checkpoint 2.
    expect(asked(cdn)).toEqual(["g1/c1.jsonl", ...segmentFiles(61, 70)]);
    const before = cdn.requests.length;

    // It is away for a while: the share is at 250, with four checkpoints.
    cdn.publishRows(250);
    await tick(SHARE_POLL_INTERVAL_MS);
    expect(cdn.head).toMatchObject({ segment: 250, checkpoint: 4 });

    const next = cdn.requests.slice(before).map((request) => request.file);
    // Checkpoint 2 holds segments it has (61 to 70), so it is not read; the
    // rest of it comes as segments. Checkpoints 3 and 4 are wholly new.
    expect(next.filter((file) => file.startsWith("g"))).toEqual(
      expect.arrayContaining(["g1/c3.jsonl", "g1/c4.jsonl"]),
    );
    expect(next).not.toContain("g1/c2.jsonl");
    expect(next).not.toContain("g1/c1.jsonl");
    for (const file of segmentFiles(71, 120)) expect(next).toContain(file);
    for (const file of segmentFiles(241, 250)) expect(next).toContain(file);
    // Nothing between the checkpoints is read on its own, and nothing is read twice.
    for (const file of segmentFiles(121, 240)) expect(next).not.toContain(file);
    expect(new Set(next.filter((file) => file !== "head.json")).size).toBe(
      next.filter((file) => file !== "head.json").length,
    );
    // Every message once, in order: 1 to 250.
    expect(run.segments.flat().map((message) => message.seq)).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    run.live.close();
  });

  it("treats a head's checkpoint count as no more than its segments support", async () => {
    const cdn = new Cdn();
    cdn.publishRows(100);
    // A head that claims five checkpoints for a hundred segments: one is complete.
    cdn.head = { ...cdn.head!, checkpoint: 5 };
    const run = follow(cdn);
    await settle();

    expect([...asked(cdn)].sort()).toEqual(
      ["g1/c1.jsonl", ...segmentFiles(61, 100)].sort(),
    );
    expect(run.segments.flat().map((message) => message.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    run.live.close();
  });

  it.each([
    ["no checkpoint field", undefined],
    ["a negative one", -3],
    ["a fraction", 1.5],
    ["text", "2"],
  ])("reads segments only from a head with %s", async (_name, checkpoint) => {
    const cdn = new Cdn();
    cdn.publishRows(130);
    const head = { ...cdn.head! } as Record<string, unknown>;
    if (checkpoint === undefined) delete head.checkpoint;
    else head.checkpoint = checkpoint;
    cdn.head = head as unknown as ShareHead;
    const run = follow(cdn);
    await settle();

    expect(asked(cdn).some((file) => /\/?c\d+\.jsonl$/.test(file))).toBe(false);
    expect([...asked(cdn)].sort()).toEqual(segmentFiles(1, 130).sort());
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });

  it("reads a rebuilt generation from its segments, which have no checkpoint", async () => {
    const cdn = new Cdn();
    cdn.publishRows(130);
    const run = follow(cdn);
    await settle();
    cdn.rebuild([[row(1), row(2)], [row(3)]]);
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(cdn.head).toMatchObject({ generation: 2, checkpoint: 0 });
    expect(cdn.count("g2/1.jsonl")).toBe(1);
    expect(cdn.count("g2/2.jsonl")).toBe(1);
    expect(cdn.count("g2/c1.jsonl")).toBe(0);
    expect(run.statuses).toEqual(["live", "recorded"]);
    run.live.close();
  });

  it("takes a checkpoint that is gone for the share having moved on, not for a stop", async () => {
    const cdn = new Cdn();
    cdn.publishRows(150);
    const release = cdn.hold("g1/c2.jsonl");
    const run = follow(cdn);
    await settle();
    expect(cdn.count("g1/c2.jsonl")).toBe(1);

    // The share is rebuilt, and the old generation's files go, checkpoints too.
    cdn.rebuild([[row(1), row(2), row(3)]]);
    release();
    await settle();

    expect(run.generations).toEqual([1, 2]);
    expect(run.statuses.at(-1)).toBe("recorded");
    expect(run.statuses).not.toContain("stopped");
    expect(run.segments.at(-1)?.map((message) => message.seq)).toEqual([1, 2, 3]);
    run.live.close();
  });

  it("calls a checkpoint that is gone while the head still names it a failed read", async () => {
    const cdn = new Cdn();
    cdn.publishRows(130);
    cdn.files.delete("g1/c2.jsonl");
    const run = follow(cdn);
    await settle();

    expect(run.statuses).toEqual(["reconnecting"]);
    // The first checkpoint was read and applied before the second was missed.
    expect(run.segments).toHaveLength(1);
    expect(run.segments[0]).toHaveLength(N);
    run.live.close();
  });

  it("carries on from the checkpoint it stopped at, applying none twice", async () => {
    const cdn = new Cdn();
    cdn.publishRows(3 * N + 5);
    cdn.broken.add("g1/c2.jsonl");
    const run = follow(cdn);
    await settle();

    expect(run.segments.map((batch) => batch[0]?.seq)).toEqual([1]);
    expect(run.statuses).toEqual(["reconnecting"]);

    cdn.broken.delete("g1/c2.jsonl");
    await tick(1_000);
    expect(run.segments.flat().map((message) => message.seq)).toEqual(
      Array.from({ length: 3 * N + 5 }, (_, index) => index + 1),
    );
    // The first checkpoint, which was applied, is not read again. The one that
    // failed is, and so is the one read ahead of it, whose answer was not used.
    expect(cdn.count("g1/c1.jsonl")).toBe(1);
    expect(cdn.count("g1/c2.jsonl")).toBe(2);
    expect(cdn.count("g1/c3.jsonl")).toBeLessThanOrEqual(2);
    expect(run.statuses).toEqual(["reconnecting", "live"]);
    run.live.close();
  });
});

describe("the plan of files to read", () => {
  const N = SHARE_CHECKPOINT_SEGMENTS;
  const paths = (applied: number, segment: number, checkpoint: number) =>
    shareFetchPlan(1, applied, { segment, checkpoint }).map((item) => item.path);

  it("is the segments after what is held when there is no checkpoint to use", () => {
    expect(paths(0, 0, 0)).toEqual([]);
    expect(paths(0, 3, 0)).toEqual(["g1/1.jsonl", "g1/2.jsonl", "g1/3.jsonl"]);
    expect(paths(5, 8, 0)).toEqual(["g1/6.jsonl", "g1/7.jsonl", "g1/8.jsonl"]);
    expect(paths(8, 8, 0)).toEqual([]);
  });

  it("is checkpoints 1 and 2 and segments 121 to 150 for a viewer joining at segment 150", () => {
    const plan = shareFetchPlan(1, 0, { segment: 150, checkpoint: 2 });

    expect(plan.map((item) => item.path)).toEqual([
      "g1/c1.jsonl",
      "g1/c2.jsonl",
      ...segmentFiles(121, 150),
    ]);
    expect(plan.map((item) => item.through).slice(0, 3)).toEqual([N, 2 * N, 121]);
  });

  it("names a rebuilt generation's files with its own number", () => {
    expect(
      shareFetchPlan(3, 0, { segment: 2, checkpoint: 0 }).map((item) => item.path),
    ).toEqual(["g3/1.jsonl", "g3/2.jsonl"]);
    expect(
      shareFetchPlan(3, 0, { segment: 61, checkpoint: 1 }).map((item) => item.path),
    ).toEqual(["g3/c1.jsonl", "g3/61.jsonl"]);
  });

  it("starts a viewer who holds part of a checkpoint with segments, up to the next one", () => {
    expect(paths(70, 250, 4).slice(0, 3)).toEqual([
      "g1/71.jsonl",
      "g1/72.jsonl",
      "g1/73.jsonl",
    ]);
    // 50 segments (71 to 120), checkpoints 3 and 4, then 241 to 250.
    expect(paths(70, 250, 4)).toHaveLength(50 + 2 + 10);
    // One who holds exactly a checkpoint's worth starts at the next one.
    expect(paths(N, 130, 2)).toEqual(["g1/c2.jsonl", ...segmentFiles(121, 130)]);
  });

  it("never reads what is held, leaves no gap, and reads a segment or a checkpoint once", () => {
    // Plain checks, collected: this runs the plan thousands of times.
    const problems: string[] = [];
    let plans = 0;
    for (let applied = 0; applied <= 190; applied += 3) {
      for (let segment = applied; segment <= applied + 260; segment += 13) {
        for (let checkpoint = 0; checkpoint <= Math.floor(segment / N); checkpoint += 1) {
          plans += 1;
          const plan = shareFetchPlan(1, applied, { segment, checkpoint });
          const label = `held ${applied}, head ${segment}/${checkpoint}`;
          let through = applied;
          for (const item of plan) {
            const checkpointFile = /\/c(\d+)\.jsonl$/.exec(item.path);
            // The first segment the file's messages are from.
            const first = checkpointFile
              ? (Number(checkpointFile[1]) - 1) * N + 1
              : item.through;
            // It starts right after the one before: no gap, and nothing held.
            if (first !== through + 1) problems.push(`${label}: ${item.path} after ${through}`);
            through = item.through;
          }
          if (through !== Math.max(applied, segment)) problems.push(`${label}: ends at ${through}`);
          if (new Set(plan.map((item) => item.path)).size !== plan.length) {
            problems.push(`${label}: a file twice`);
          }
          if (plan.length > Math.max(0, segment - applied)) {
            problems.push(`${label}: more files than segments`);
          }
        }
      }
    }

    expect(plans).toBeGreaterThan(1_000);
    expect(problems).toEqual([]);
  });

  it("reads fewer files than segments once a checkpoint is in reach", () => {
    expect(paths(0, 6_000, 100)).toHaveLength(100);
    expect(paths(0, 6_000 + 59, 100)).toHaveLength(100 + 59);
    expect(paths(0, 6_000, 0)).toHaveLength(6_000);
  });
});

describe("a share that is rebuilt from the recordings", () => {
  it("switches when the head's generation changes: announced, read from the first segment", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    const run = follow(cdn);
    await settle();
    expect(run.statuses).toEqual(["live"]);

    // The recordings have the same sessions, numbered from 1 again.
    cdn.rebuild([[row(1), row(2)], [row(3)], [row(4)]]);
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(run.generations).toEqual([1, 2]);
    expect(seqs(run.segments)).toEqual([[1], [2], [1, 2], [3], [4]]);
    // The new generation is said in the same breath as its first segment, so
    // the viewer swaps one log for the other with no empty frame between.
    expect(run.told.slice(-5)).toEqual([
      "generation 2",
      "segment 1,2",
      "segment 3",
      "segment 4",
      "head",
    ]);
    expect(run.statuses).toEqual(["live", "recorded"]);
    // The old generation is not read again, and the mission is not either.
    expect(cdn.count("g1/1.jsonl")).toBe(1);
    expect(cdn.count("g1/2.jsonl")).toBe(1);
    expect(cdn.count("g2/1.jsonl")).toBe(1);
    expect(cdn.count("mission.json")).toBe(1);
    run.live.close();
  });

  it("switches back from any other generation, not only the next", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();
    cdn.head = { ...FIRST_HEAD, generation: 7, segment: 1, recorded: true };
    cdn.files.set("g7/1.jsonl", JSON.stringify(row(1)));
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(run.generations).toEqual([1, 7]);
    expect(cdn.count("g7/1.jsonl")).toBe(1);
    run.live.close();
  });

  it("tells a new generation that has no segment, and still hands over its head", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();
    cdn.rebuild([]);
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(run.generations).toEqual([1, 2]);
    expect(run.told.slice(-2)).toEqual(["generation 2", "head"]);
    expect(run.statuses).toEqual(["live", "recorded"]);
    run.live.close();
  });

  it("takes a segment that is gone for the share having moved on, not for a stop", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    cdn.publish(row(3));
    const run = follow(cdn);
    await settle();
    expect(seqs(run.segments)).toEqual([[1], [2], [3]]);

    // The learner's run ends. The viewer has read the head (the live
    // generation) and is asking for its newest segment when the share is
    // rebuilt and the old files are deleted.
    cdn.publish(row(4));
    const release = cdn.hold("g1/4.jsonl");
    await tick(SHARE_POLL_INTERVAL_MS);
    expect(cdn.count("g1/4.jsonl")).toBe(1);
    cdn.rebuild([[row(1), row(2), row(3), row(4)]]);
    release();
    await settle();

    // Not "stopped": it looked at the head again and found the new generation.
    expect(run.statuses).toEqual(["live", "recorded"]);
    expect(run.generations).toEqual([1, 2]);
    expect(seqs(run.segments).at(-1)).toEqual([1, 2, 3, 4]);
    expect(cdn.count("head.json")).toBeGreaterThanOrEqual(3);
    run.live.close();
  });

  it("calls a segment that is gone while the head still names it a failed read, not a stop", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    cdn.files.delete("g1/2.jsonl");
    const run = follow(cdn);
    await settle();

    // The share may be mid-delete, and the head is about to be gone too.
    expect(run.statuses).toEqual(["reconnecting"]);
    expect(seqs(run.segments)).toEqual([[1]]);

    cdn.head = null;
    await tick(1_000);
    expect(run.statuses).toEqual(["reconnecting", "stopped"]);
    run.live.close();
  });

  it("carries on with a generation that failed midway, without telling it twice", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();
    cdn.rebuild([[row(1)], [row(2)], [row(3)]]);
    cdn.broken.add("g2/2.jsonl");
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(run.generations).toEqual([1, 2]);
    expect(seqs(run.segments)).toEqual([[1], [1]]);
    expect(run.statuses).toEqual(["live", "reconnecting"]);

    cdn.broken.delete("g2/2.jsonl");
    await tick(1_000);
    expect(seqs(run.segments)).toEqual([[1], [1], [2], [3]]);
    expect(run.generations).toEqual([1, 2]);
    expect(cdn.count("g2/1.jsonl")).toBe(1);
    expect(run.statuses).toEqual(["live", "reconnecting", "recorded"]);
    run.live.close();
  });

  it("is recorded on a share it joins that was rebuilt already", async () => {
    const cdn = new Cdn();
    cdn.rebuild([[row(1)], [row(2)]]);
    const run = follow(cdn);
    await settle();

    expect(run.generations).toEqual([2]);
    expect(seqs(run.segments)).toEqual([[1], [2]]);
    expect(run.statuses).toEqual(["recorded"]);
    run.live.close();
  });

  it("stops polling fast once the share is recorded, and checks now and then that it is still there", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();
    cdn.rebuild([[row(1)]]);
    await tick(SHARE_POLL_INTERVAL_MS);
    expect(run.statuses).toEqual(["live", "recorded"]);
    const heads = cdn.count("head.json");

    // Nothing changes in a recording: no head read for a long while.
    await tick(SHARE_RECORDED_POLL_INTERVAL_MS - 1);
    expect(cdn.count("head.json")).toBe(heads);
    await tick(1);
    expect(cdn.count("head.json")).toBe(heads + 1);
    expect(run.statuses).toEqual(["live", "recorded"]);

    // The learner stops sharing: the next look finds nothing.
    cdn.head = null;
    await tick(SHARE_RECORDED_POLL_INTERVAL_MS);
    expect(run.statuses).toEqual(["live", "recorded", "stopped"]);
    const asked = cdn.requests.length;
    await tick(10 * 60_000);
    expect(cdn.requests).toHaveLength(asked);
    run.live.close();
  });
});

describe("a share that is gone", () => {
  it.each([
    ["the head", (cdn: Cdn) => (cdn.head = null)],
    ["the mission", (cdn: Cdn) => (cdn.mission = null)],
  ])("is stopped when %s is a 404 on the first read", async (_name, remove) => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    remove(cdn);
    const run = follow(cdn);
    await settle();

    expect(run.statuses).toEqual(["stopped"]);
    expect(run.segments).toEqual([]);
    // Final: nothing is asked of the CDN again by itself.
    const asked = cdn.requests.length;
    await tick(10 * 60_000);
    expect(cdn.requests).toHaveLength(asked);
    run.live.close();
  });

  it("is stopped when the head is gone later, and keeps what it had", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const run = follow(cdn);
    await settle();
    cdn.head = null;
    await tick(SHARE_POLL_INTERVAL_MS);

    expect(run.statuses).toEqual(["live", "stopped"]);
    expect(seqs(run.segments)).toEqual([[1]]);
    const asked = cdn.requests.length;
    await tick(10 * 60_000);
    expect(cdn.requests).toHaveLength(asked);
    run.live.close();
  });

  it("is stopped when the head is gone as it looks again after a missing segment", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    const run = follow(cdn);
    await settle();

    // The whole share is deleted while the newest segment is being read.
    cdn.publish(row(3));
    const release = cdn.hold("g1/3.jsonl");
    await tick(SHARE_POLL_INTERVAL_MS);
    cdn.head = null;
    cdn.files.clear();
    release();
    await settle();

    expect(run.statuses).toEqual(["live", "stopped"]);
    run.live.close();
  });
});

describe("reads that fail", () => {
  it.each([500, 502, 503, 429, 403])(
    "is not a stopped share when the CDN answers %i",
    async (status) => {
      const cdn = new Cdn();
      cdn.statuses.set("head.json", status);
      const run = follow(cdn);
      await settle();

      expect(run.statuses).toEqual(["reconnecting"]);
      run.live.close();
    },
  );

  it("retries with a backoff of one second doubling, and goes back to live", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.broken.add("head.json");
    const run = follow(cdn);
    await settle();
    expect(run.statuses).toEqual(["reconnecting"]);
    expect(cdn.count("head.json")).toBe(1);

    await tick(999);
    expect(cdn.count("head.json")).toBe(1);
    await tick(1);
    expect(cdn.count("head.json")).toBe(2);
    // The second wait is two seconds.
    await tick(1_999);
    expect(cdn.count("head.json")).toBe(2);
    await tick(1);
    expect(cdn.count("head.json")).toBe(3);

    cdn.broken.delete("head.json");
    await tick(4_000);
    expect(run.statuses).toEqual(["reconnecting", "live"]);
    expect(seqs(run.segments)).toEqual([[1]]);
    expect(run.missions).toEqual([mission]);
    run.live.close();
  });

  it("jitters the wait by 30% either way", () => {
    expect(shareRetryDelay(0, 0)).toBe(700);
    expect(shareRetryDelay(0, 0.5)).toBe(1_000);
    expect(shareRetryDelay(0, 1)).toBe(1_300);
    expect(shareRetryDelay(3, 0.5)).toBe(8_000);
    expect(shareRetryDelay(20, 0.5)).toBe(30_000);
    expect(shareRetryDelay(20, 0)).toBe(21_000);
    expect(shareRetryDelay(20, 1)).toBe(39_000);
    expect(shareRetryDelay(5_000, 0.5)).toBe(30_000);
  });

  it("carries on from the segment it stopped at, applying none twice", async () => {
    const cdn = new Cdn();
    for (let segment = 1; segment <= 4; segment += 1) cdn.publish(row(segment));
    cdn.broken.add("g1/3.jsonl");
    const run = follow(cdn);
    await settle();

    expect(seqs(run.segments)).toEqual([[1], [2]]);
    expect(run.statuses).toEqual(["reconnecting"]);

    cdn.broken.delete("g1/3.jsonl");
    await tick(1_000);
    expect(seqs(run.segments)).toEqual([[1], [2], [3], [4]]);
    expect(run.statuses).toEqual(["reconnecting", "live"]);
    expect(cdn.count("g1/1.jsonl")).toBe(1);
    expect(cdn.count("g1/2.jsonl")).toBe(1);
    expect(run.missions).toHaveLength(1);
    expect(run.generations).toEqual([1]);
    run.live.close();
  });

  it("calls the share unavailable after a run of failures, once, and stops", async () => {
    const cdn = new Cdn();
    cdn.broken.add("head.json");
    const run = follow(cdn);
    const started = Date.now();
    for (let failed = 1; failed < SHARE_FAILURES_BEFORE_UNAVAILABLE; failed += 1) {
      await settle();
      expect(run.statuses.at(-1)).toBe("reconnecting");
      await vi.advanceTimersToNextTimerAsync();
    }
    await settle();

    expect(run.statuses).toEqual(["reconnecting", "unavailable"]);
    expect(cdn.count("head.json")).toBe(SHARE_FAILURES_BEFORE_UNAVAILABLE);
    // The waits were 1, 2, 4, 8 and 16 seconds: about half a minute.
    expect(Date.now() - started).toBe(31_000);
    await tick(10 * 60_000);
    expect(cdn.count("head.json")).toBe(SHARE_FAILURES_BEFORE_UNAVAILABLE);
    run.live.close();
  });

  it("reads again on retry, with the count started over", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.broken.add("head.json");
    const run = follow(cdn);
    for (let failed = 1; failed < SHARE_FAILURES_BEFORE_UNAVAILABLE; failed += 1) {
      await settle();
      await vi.advanceTimersToNextTimerAsync();
    }
    await settle();
    expect(run.statuses.at(-1)).toBe("unavailable");

    // Still down: one failure is not the end again.
    run.live.retry();
    await settle();
    expect(run.statuses.at(-1)).toBe("reconnecting");

    cdn.broken.delete("head.json");
    await tick(1_000);
    expect(run.statuses.at(-1)).toBe("live");
    expect(seqs(run.segments)).toEqual([[1]]);
    run.live.close();
  });

  it("does not count a read that got further than the last one as a failure", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    cdn.publish(row(2));
    cdn.broken.add("head.json");
    const run = follow(cdn);
    // Five reads in a row fail: one short of the end.
    for (let failed = 1; failed < SHARE_FAILURES_BEFORE_UNAVAILABLE - 1; failed += 1) {
      await settle();
      await vi.advanceTimersToNextTimerAsync();
    }
    await settle();
    expect(cdn.count("head.json")).toBe(SHARE_FAILURES_BEFORE_UNAVAILABLE - 1);

    // The head is back and the first segment comes, but not the second.
    cdn.broken.delete("head.json");
    cdn.broken.add("g1/2.jsonl");
    await vi.advanceTimersToNextTimerAsync();
    await settle();
    expect(seqs(run.segments)).toEqual([[1]]);
    // Counting this as a sixth failure would have ended it here.
    expect(run.statuses).not.toContain("unavailable");
    expect(run.statuses.at(-1)).toBe("reconnecting");

    cdn.broken.delete("g1/2.jsonl");
    await tick(1_000);
    expect(seqs(run.segments)).toEqual([[1], [2]]);
    expect(run.statuses.at(-1)).toBe("live");
    run.live.close();
  });

  it("calls a read that hangs a failure", async () => {
    vi.useRealTimers();
    const cdn = new Cdn();
    cdn.hold("head.json");
    const run = follow(cdn, { requestTimeoutMs: 20 });

    await vi.waitFor(() => expect(run.statuses).toEqual(["reconnecting"]), {
      timeout: 2_000,
    });
    expect(
      (headRequest(cdn)?.init?.signal as AbortSignal | undefined)?.aborted,
    ).toBe(true);
    run.live.close();
  });
});

describe("retry", () => {
  it("reads at once and says the answer again even when it is the same", async () => {
    const cdn = new Cdn();
    cdn.head = null;
    const run = follow(cdn);
    await settle();
    expect(run.statuses).toEqual(["stopped"]);

    run.live.retry();
    await settle();
    expect(run.statuses).toEqual(["stopped", "stopped"]);

    cdn.head = { ...FIRST_HEAD };
    run.live.retry();
    await settle();
    expect(run.statuses).toEqual(["stopped", "stopped", "live"]);
    run.live.close();
  });

  it("does not wait out a backoff", async () => {
    const cdn = new Cdn();
    cdn.broken.add("head.json");
    const run = follow(cdn);
    await settle();
    expect(cdn.count("head.json")).toBe(1);

    run.live.retry();
    await settle();
    expect(cdn.count("head.json")).toBe(2);
    run.live.close();
  });

  it("does nothing while a read is in flight", async () => {
    const cdn = new Cdn();
    const release = cdn.hold("head.json");
    const run = follow(cdn);
    await settle();

    run.live.retry();
    await settle();
    expect(cdn.count("head.json")).toBe(1);
    release();
    await settle();
    expect(run.statuses).toEqual(["live"]);
    run.live.close();
  });
});

describe("closing", () => {
  it("stops reading, drops what is in flight, and says nothing more", async () => {
    const cdn = new Cdn();
    cdn.publish(row(1));
    const release = cdn.hold("head.json");
    const run = follow(cdn);
    await settle();
    const signal = headRequest(cdn)?.init?.signal as AbortSignal;

    run.live.close();
    expect(signal.aborted).toBe(true);
    release();
    await settle();
    await tick(10 * 60_000);

    expect(run.statuses).toEqual([]);
    expect(run.told).toEqual([]);
    expect(cdn.requests).toHaveLength(2);
  });

  it("does not poll again once closed between two reads", async () => {
    const cdn = new Cdn();
    const run = follow(cdn);
    await settle();
    run.live.close();
    await tick(10 * 60_000);

    expect(cdn.count("head.json")).toBe(1);
  });
});

describe("segments", () => {
  it("reads one message per line, in order", () => {
    const text = [row(1), row(2), row(3)]
      .map((message) => JSON.stringify(message))
      .join("\n");

    expect(parseShareSegment(text).map((message) => message.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it("skips a line that is not a message instead of losing the rest", () => {
    const text = [
      JSON.stringify(row(1)),
      "",
      "{not json",
      "42",
      "null",
      JSON.stringify({ no: "type" }),
      JSON.stringify(row(2)),
      "",
    ].join("\n");

    expect(parseShareSegment(text).map((message) => message.seq)).toEqual([
      1, 2,
    ]);
    expect(parseShareSegment("")).toEqual([]);
  });

  it("delivers a segment's messages together, with the lines that were readable", async () => {
    const cdn = new Cdn();
    cdn.files.set(
      "g1/1.jsonl",
      [JSON.stringify(row(1)), "garbage", JSON.stringify(row(2))].join("\n"),
    );
    cdn.head = { ...FIRST_HEAD, segment: 1, seq: 2 };
    const run = follow(cdn);
    await settle();

    expect(seqs(run.segments)).toEqual([[1, 2]]);
    run.live.close();
  });

  it("builds a path from the origin, the share id and the file", () => {
    expect(shareLiveUrl("https://live.example.test", SHARE_ID, "head.json")).toBe(
      `https://live.example.test/${SHARE_ID}/head.json`,
    );
    // A slash at the end of the origin does not double up.
    expect(
      shareLiveUrl("https://live.example.test/", SHARE_ID, "g2/12.jsonl"),
    ).toBe(`https://live.example.test/${SHARE_ID}/g2/12.jsonl`);
  });
});
