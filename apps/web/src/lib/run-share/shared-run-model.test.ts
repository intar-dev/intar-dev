import { describe, expect, it } from "vitest";
import type { ShareEvent } from "@/generated/stargate";
import type { ShareViewerMessage, SharedRunMission } from "./protocol";
import {
  SHARE_MAX_CELLS,
  applyShareMessages,
  clampShareGrid,
  createSharedRunState,
  currentShareGrid,
  followedSession,
  parseShareId,
  parseShareResize,
  reduceShareMessage,
  shareSessionPhase,
  shareTabs,
  type ShareSession,
  type ShareStatus,
  type ShareUpdate,
  type SharedRunState,
} from "./shared-run-model";

const mission: SharedRunMission = {
  title: "Repair a broken nginx service",
  tagline: "Bring the website back online.",
  scenario_name: "repair-nginx",
  lecture_title: "Service recovery",
  markdown: "## Service recovery",
  objectives: [],
  vms: [
    { id: "vm_web", name: "web" },
    { id: "vm_db", name: "db" },
  ],
};

/** The mission file has been read. */
const readMission = (): ShareUpdate => ({ type: "mission", mission });

function start(
  session: string,
  overrides: Partial<Extract<ShareViewerMessage, { type: "start" }>> = {},
): ShareUpdate {
  return {
    type: "start",
    session,
    vm_id: "vm_web",
    mode: "browser",
    cols: 120,
    rows: 30,
    at_ms: 1_791_187_200_000,
    mid_session: false,
    resumed: false,
    ...overrides,
  };
}

const events = (
  session: string,
  list: ShareEvent[],
  seq?: number,
): ShareUpdate => ({
  type: "events",
  session,
  events: list,
  ...(seq === undefined ? {} : { seq }),
});

function apply(...messages: ShareUpdate[]): SharedRunState {
  return applyShareMessages(createSharedRunState(), messages);
}

describe("share id", () => {
  it("accepts 22 base64url characters, with or without the hash", () => {
    expect(parseShareId("Zm9vYmFyYmF6cXV4cXV1eA")).toBe("Zm9vYmFyYmF6cXV4cXV1eA");
    expect(parseShareId("#Zm9vYmFyYmF6cXV4cXV1eA")).toBe("Zm9vYmFyYmF6cXV4cXV1eA");
    expect(parseShareId("a-b_c-d_e-f_g-h_i-j_kl")).toBe("a-b_c-d_e-f_g-h_i-j_kl");
  });

  it("rejects anything else before it can reach a server", () => {
    expect(parseShareId("")).toBeNull();
    expect(parseShareId("#")).toBeNull();
    expect(parseShareId("Zm9vYmFyYmF6cXV4cXV1e")).toBeNull();
    expect(parseShareId("Zm9vYmFyYmF6cXV4cXV1eAA")).toBeNull();
    expect(parseShareId("Zm9vYmFyYmF6cXV4cXV1e=")).toBeNull();
    expect(parseShareId("Zm9vYmFyYmF6cXV4cXV1e+")).toBeNull();
    expect(parseShareId("##Zm9vYmFyYmF6cXV4cXV1eA")).toBeNull();
    expect(parseShareId("Zm9vYmFyYmF6cXV4cXV1e&")).toBeNull();
  });
});

describe("sessions", () => {
  it("opens a new tab for every session that starts, in arrival order", () => {
    const state = apply(
      readMission(),
      start("a"),
      start("b", { mode: "native" }),
      start("c", { vm_id: "vm_db" }),
    );

    expect(state.sessions.map((session) => session.id)).toEqual(["a", "b", "c"]);
    expect(state.sessions.map((session) => session.mode)).toEqual([
      "browser",
      "native",
      "browser",
    ]);
    expect(state.sessions.every((session) => session.status === "live")).toBe(
      true,
    );
  });

  it("numbers the tabs per machine and names them from the mission", () => {
    const state = apply(
      readMission(),
      start("a"),
      start("b", { vm_id: "vm_db" }),
      start("c"),
      start("d", { vm_id: "vm_gone" }),
    );

    expect(shareTabs(state).map((tab) => tab.label)).toEqual([
      "web · 1",
      "db · 1",
      "web · 2",
      // A machine the mission does not list is still told apart by its id.
      "vm_gone · 1",
    ]);
  });

  it("keeps one tab when a session resumes, and makes it live again", () => {
    const state = apply(
      readMission(),
      start("a"),
      events("a", [[0, "o", "$ "]]),
      { type: "detach", session: "a" },
      start("a", { resumed: true }),
    );

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ id: "a", status: "live" });
    expect(state.sessions[0]?.events).toEqual([[0, "o", "$ "]]);
  });

  it("turns a size the writer reports on resume into a resize event", () => {
    const state = apply(
      readMission(),
      start("a"),
      events("a", [
        [0, "o", "$ "],
        [250, "r", "100x40"],
      ]),
      { type: "detach", session: "a" },
      // Same size as the last resize in the log: nothing to add.
      start("a", { resumed: true, cols: 100, rows: 40 }),
    );
    expect(state.sessions[0]?.events).toHaveLength(2);

    const resized = applyShareMessages(state, [
      start("a", { resumed: true, cols: 90, rows: 20 }),
    ]);
    expect(resized.sessions).toHaveLength(1);
    expect(resized.sessions[0]?.events.at(-1)).toEqual([250, "r", "90x20"]);
    // The log began at 120x30 and still says so; the resize is an event.
    expect(resized.sessions[0]).toMatchObject({ cols: 120, rows: 30 });
    expect(currentShareGrid(resized.sessions[0]!)).toEqual({
      cols: 90,
      rows: 20,
    });
  });

  it("marks sessions ended and detached, and an ended one stays ended", () => {
    const state = apply(
      readMission(),
      start("a"),
      start("b"),
      start("c"),
      { type: "end", session: "a" },
      { type: "detach", session: "b" },
      { type: "end", session: "c" },
      { type: "detach", session: "c" },
    );

    expect(state.sessions.map((session) => session.status)).toEqual([
      "ended",
      "detached",
      "ended",
    ]);
  });

  it("appends events and counts dropped output per session", () => {
    const state = apply(
      readMission(),
      start("a"),
      start("b"),
      events("a", [[0, "o", "one"]]),
      events("b", [[0, "o", "other"]]),
      events("a", [
        [10, "o", "two"],
        [20, "o", "three"],
      ]),
      { type: "gap", session: "a", bytes: 4096 },
      { type: "gap", session: "a", bytes: 1 },
    );

    expect(state.sessions[0]?.events.map((event) => event[2])).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(state.sessions[0]?.gapBytes).toBe(4097);
    expect(state.sessions[1]?.events).toHaveLength(1);
    expect(state.sessions[1]?.gapBytes).toBe(0);
  });

  it("does not mutate the state it was given", () => {
    const first = apply(readMission(), start("a"), events("a", [[0, "o", "x"]]));
    const frozenEvents = first.sessions[0]!.events;
    const second = applyShareMessages(first, [events("a", [[1, "o", "y"]])]);

    expect(frozenEvents).toHaveLength(1);
    expect(second.sessions[0]?.events).toHaveLength(2);
    expect(second.sessions).not.toBe(first.sessions);
  });

  it("ignores messages for a session it never saw start", () => {
    const state = apply(
      readMission(),
      events("ghost", [[0, "o", "x"]]),
      { type: "end", session: "ghost" },
      { type: "gap", session: "ghost", bytes: 1 },
    );

    expect(state.sessions).toEqual([]);
  });

  it("handles a long history without losing an event", () => {
    const messages: ShareUpdate[] = [readMission(), start("a")];
    for (let index = 0; index < 5_000; index += 1) {
      messages.push(events("a", [[index, "o", "x"]]));
    }
    const state = apply(...messages);

    expect(state.sessions[0]?.events).toHaveLength(5_000);
  });
});

describe("a batch of messages", () => {
  it("applies the 20,000 rows of a long history in one batch, in order", () => {
    const rows = 20_000;
    const messages: ShareUpdate[] = [
      readMission(),
      start("a"),
      start("b", { mode: "native" }),
    ];
    // Two sessions interleave, as a share's log does.
    for (let index = 0; index < rows; index += 1) {
      messages.push(
        events(
          "a",
          [
            [index * 2, "o", `a${index}`],
            [index * 2 + 1, "o", ";"],
          ],
          index * 2 + 1,
        ),
        events("b", [[index, "o", `b${index}`]], index * 2 + 2),
      );
    }

    const before = createSharedRunState();
    const state = applyShareMessages(before, messages);

    const [a, b] = state.sessions as [ShareSession, ShareSession];
    expect(a.events).toHaveLength(rows * 2);
    expect(b.events).toHaveLength(rows);
    // Nothing lost, reordered or crossed between the two.
    for (let index = 0; index < rows; index += 1) {
      expect(a.events[index * 2]).toEqual([index * 2, "o", `a${index}`]);
      expect(b.events[index]).toEqual([index, "o", `b${index}`]);
    }
    expect(state.seq).toBe(rows * 2);
    // The state it was given is as it was.
    expect(before).toEqual(createSharedRunState());
    expect(before.sessions).toEqual([]);
  });

  it("takes one row of hundreds of thousands of events", () => {
    // Spreading a row like this into push() would overflow the stack.
    const row = Array.from(
      { length: 300_000 },
      (_, index): ShareEvent => [index, "o", "x"],
    );
    const state = apply(readMission(), start("a"), events("a", row));

    expect(state.sessions[0]?.events).toHaveLength(300_000);
    expect(state.sessions[0]?.events.at(-1)).toEqual([299_999, "o", "x"]);
  });

  it("copies a session's events once per batch, however many rows it has", () => {
    let copies = 0;
    // An array that counts every copy made of it, and of its copies.
    class CountingEvents extends Array<ShareEvent> {
      override slice(start?: number, end?: number): ShareEvent[] {
        copies += 1;
        return super.slice(start, end);
      }
      override concat(
        ...items: Array<ConcatArray<ShareEvent> | ShareEvent>
      ): ShareEvent[] {
        copies += 1;
        return super.concat(...items);
      }
    }
    const seed = new CountingEvents();
    const state: SharedRunState = {
      ...createSharedRunState(),
      sessions: [
        {
          id: "a",
          vmId: "vm_web",
          mode: "browser",
          cols: 80,
          rows: 24,
          atMs: 0,
          midSession: false,
          events: seed,
          status: "live",
          gapBytes: 0,
        },
      ],
    };
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      events("a", [[index, "o", "x"]]),
    );

    const next = applyShareMessages(state, rows);

    expect(next.sessions[0]?.events).toHaveLength(2_000);
    // One copy for the whole batch. A copy per row would be 2,000 of them.
    expect(copies).toBeLessThanOrEqual(1);
    // And the array it was given was not the one appended to.
    expect(seed).toHaveLength(0);
  });

  it("appends to the batch's own copy from the second row on", () => {
    const copied = new Set<string>();
    let state = reduceShareMessage(createSharedRunState(), readMission(), copied);
    state = reduceShareMessage(state, start("a"), copied);
    const given = state.sessions[0]!.events;

    state = reduceShareMessage(state, events("a", [[0, "o", "0"]]), copied);
    const owned = state.sessions[0]!.events;
    expect(owned).not.toBe(given);
    for (let index = 1; index < 100; index += 1) {
      state = reduceShareMessage(state, events("a", [[index, "o", "x"]]), copied);
      expect(state.sessions[0]?.events).toBe(owned);
    }
    expect(owned).toHaveLength(100);
    expect(given).toHaveLength(0);
  });

  it("copies on every call when no batch owns the array", () => {
    const first = apply(readMission(), start("a"), events("a", [[0, "o", "x"]]));
    const second = reduceShareMessage(first, events("a", [[1, "o", "y"]]));
    const third = reduceShareMessage(second, events("a", [[2, "o", "z"]]));

    expect(first.sessions[0]?.events).toHaveLength(1);
    expect(second.sessions[0]?.events).toHaveLength(2);
    expect(third.sessions[0]?.events).toHaveLength(3);
    expect(third.sessions[0]?.events).not.toBe(second.sessions[0]?.events);
  });

  it("starts every batch with its own copy, so an earlier result stays whole", () => {
    const first = applyShareMessages(createSharedRunState(), [
      readMission(),
      start("a"),
      events("a", [[0, "o", "x"]]),
      events("a", [[1, "o", "y"]]),
    ]);
    const kept = first.sessions[0]!.events;
    const second = applyShareMessages(first, [
      events("a", [[2, "o", "z"]]),
      events("a", [[3, "o", "w"]]),
    ]);

    expect(kept.map((event) => event[2])).toEqual(["x", "y"]);
    expect(second.sessions[0]?.events.map((event) => event[2])).toEqual([
      "x",
      "y",
      "z",
      "w",
    ]);
    expect(second.sessions[0]?.events).not.toBe(kept);
  });

  it("appends a resumed session's resize to the same copy as the rows around it", () => {
    const before = apply(
      readMission(),
      start("a"),
      events("a", [[100, "o", "$ "]]),
      { type: "detach", session: "a" },
    );
    const given = before.sessions[0]!.events;

    const after = applyShareMessages(before, [
      events("a", [[150, "o", "more "]]),
      start("a", { resumed: true, cols: 90, rows: 20 }),
      events("a", [[200, "o", "back"]]),
      events("a", [[300, "o", "!"]]),
    ]);

    expect(after.sessions[0]?.events).toEqual([
      [100, "o", "$ "],
      [150, "o", "more "],
      [150, "r", "90x20"],
      [200, "o", "back"],
      [300, "o", "!"],
    ]);
    expect(after.sessions[0]?.status).toBe("live");
    expect(given).toEqual([[100, "o", "$ "]]);
  });
});

describe("session phase", () => {
  const live = { status: "live" } as const;
  const detached = { status: "detached" } as const;
  const ended = { status: "ended" } as const;

  it("is live only while the link is live", () => {
    expect(shareSessionPhase(live, "live")).toBe("live");
    for (const link of ["reconnecting", "unavailable"] as const) {
      expect(shareSessionPhase(live, link)).toBe("reconnecting");
    }
  });

  it("is loading while the history of the share is still being read", () => {
    // Not reconnecting: nothing was lost, the viewer has not caught up yet.
    expect(shareSessionPhase(live, "connecting")).toBe("loading");
    expect(shareSessionPhase({ status: "detached" }, "connecting")).toBe(
      "interrupted",
    );
  });

  it("is stopped for every session that had not ended once the share is stopped", () => {
    // A stopped share records no end or detach, so these still say live.
    expect(shareSessionPhase(live, "stopped")).toBe("stopped");
    expect(shareSessionPhase(detached, "stopped")).toBe("stopped");
  });

  it("keeps an ended session ended on every link", () => {
    const links: ShareStatus[] = [
      "connecting",
      "live",
      "recorded",
      "reconnecting",
      "stopped",
      "unavailable",
    ];
    for (const link of links) {
      expect(shareSessionPhase(ended, link)).toBe("ended");
    }
  });

  it("is ended on a recording, whatever its log leaves open", () => {
    // A recording has nothing live in it.
    expect(shareSessionPhase(live, "recorded")).toBe("ended");
    expect(shareSessionPhase(detached, "recorded")).toBe("ended");
    expect(shareSessionPhase(ended, "recorded")).toBe("ended");
  });

  it("is interrupted while a dropped writer may still resume", () => {
    expect(shareSessionPhase(detached, "live")).toBe("interrupted");
    expect(shareSessionPhase(detached, "reconnecting")).toBe("interrupted");
  });
});

describe("truncation and mission", () => {
  it("is truncated once a truncated message has said so", () => {
    expect(apply(readMission()).truncated).toBe(false);
    expect(apply(readMission(), { type: "truncated" }).truncated).toBe(true);
  });

  it("keeps the state it has when truncation is said again", () => {
    const once = apply(readMission(), { type: "truncated", seq: 4 });
    const again = reduceShareMessage(once, { type: "truncated" });

    expect(again).toBe(once);
  });

  it("holds the mission once it is read, and a mission read again is the same state", () => {
    expect(createSharedRunState().mission).toBeNull();
    const state = apply(readMission());
    expect(state.mission).toBe(mission);
    expect(reduceShareMessage(state, { type: "mission", mission })).toBe(state);

    const renamed: SharedRunMission = { ...mission, title: "Renamed" };
    expect(
      reduceShareMessage(state, { type: "mission", mission: renamed }).mission,
    ).toBe(renamed);
  });

  it("does not need the mission for the log: events apply before it is read", () => {
    const state = apply(start("a"), events("a", [[0, "o", "x"]]));

    expect(state.mission).toBeNull();
    expect(state.sessions[0]?.events).toHaveLength(1);
  });
});

describe("generations", () => {
  const generation = (value: number): ShareUpdate => ({
    type: "generation",
    generation: value,
  });
  const numbered = (
    session: string,
    seq: number,
    text: string,
  ): ShareUpdate => events(session, [[seq, "o", text]], seq);
  const seqStart = (session: string, seq: number): ShareUpdate => ({
    ...(start(session) as Extract<ShareViewerMessage, { type: "start" }>),
    seq,
  });

  it("starts with none, and takes the first one without anything to drop", () => {
    expect(createSharedRunState().generation).toBeNull();

    const state = apply(readMission(), generation(1), seqStart("a", 1));
    expect(state.generation).toBe(1);
    expect(state.sessions.map((session) => session.id)).toEqual(["a"]);
  });

  it("drops every session when the share is rebuilt, and keeps the mission", () => {
    const live = apply(
      readMission(),
      generation(1),
      seqStart("a", 1),
      numbered("a", 2, "live output"),
      seqStart("b", 3),
      { type: "truncated", seq: 4 },
    );
    expect(live.truncated).toBe(true);

    const rebuilt = applyShareMessages(live, [generation(2)]);

    expect(rebuilt.generation).toBe(2);
    expect(rebuilt.sessions).toEqual([]);
    expect(rebuilt.mission).toBe(mission);
    // The rebuilt log has no stored replay to cut short, and starts over.
    expect(rebuilt.truncated).toBe(false);
    expect(rebuilt.seq).toBeNull();
  });

  it("numbers the new log from the start again: a low seq is new, not already applied", () => {
    const live = apply(
      readMission(),
      generation(1),
      seqStart("a", 1),
      numbered("a", 2, "one"),
      numbered("a", 3, "two"),
    );
    expect(live.seq).toBe(3);

    // Without the reset these (seq 1 and 2) would be skipped as applied.
    const rebuilt = applyShareMessages(live, [
      generation(2),
      seqStart("a", 1),
      numbered("a", 2, "recorded"),
    ]);

    expect(rebuilt.sessions).toHaveLength(1);
    expect(rebuilt.sessions[0]?.events).toEqual([[2, "o", "recorded"]]);
    expect(rebuilt.seq).toBe(2);
  });

  it("brings a session with the same id back as a new one, from the rebuilt log", () => {
    const live = apply(
      readMission(),
      generation(1),
      seqStart("a", 1),
      numbered("a", 2, "live"),
    );
    const before = live.sessions[0]!;

    const rebuilt = applyShareMessages(live, [
      generation(2),
      seqStart("a", 1),
      numbered("a", 2, "from the recording"),
      { type: "end", session: "a", seq: 3 },
    ]);

    expect(rebuilt.sessions).toHaveLength(1);
    expect(rebuilt.sessions[0]).not.toBe(before);
    expect(rebuilt.sessions[0]?.events).toEqual([[2, "o", "from the recording"]]);
    expect(rebuilt.sessions[0]?.status).toBe("ended");
    // What the viewer held before is left as it was.
    expect(before.events).toEqual([[2, "o", "live"]]);
    expect(before.status).toBe("live");
  });

  it("rebuilds tabs in the new log's order, whatever the old one's was", () => {
    const live = apply(
      readMission(),
      generation(1),
      seqStart("b", 1),
      seqStart("a", 2),
    );
    expect(live.sessions.map((session) => session.id)).toEqual(["b", "a"]);

    const rebuilt = applyShareMessages(live, [
      generation(2),
      seqStart("a", 1),
      seqStart("b", 2),
      seqStart("c", 3),
    ]);
    expect(rebuilt.sessions.map((session) => session.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps the same state when the generation is told again", () => {
    const state = apply(readMission(), generation(2), seqStart("a", 1));

    expect(reduceShareMessage(state, generation(2))).toBe(state);
  });

  it("takes a truncated flag the new generation's head carries", () => {
    const rebuilt = apply(
      readMission(),
      generation(1),
      { type: "truncated", seq: 1 },
      generation(2),
      { type: "truncated" },
    );

    expect(rebuilt.truncated).toBe(true);
  });

  it("switches in the middle of a batch without writing into what came before", () => {
    const first = apply(
      readMission(),
      generation(1),
      seqStart("a", 1),
      numbered("a", 2, "live"),
    );
    const live = first.sessions[0]!.events;

    // The old log's last rows and the new log's first, in one batch.
    const next = applyShareMessages(first, [
      numbered("a", 3, " more live"),
      generation(2),
      seqStart("a", 1),
      numbered("a", 2, "recorded"),
      numbered("a", 3, " and more"),
    ]);

    expect(next.sessions[0]?.events.map((event) => event[2]).join("")).toBe(
      "recorded and more",
    );
    expect(live).toEqual([[2, "o", "live"]]);
  });
});

describe("log sequence", () => {
  const seqStart = (session: string, seq: number): ShareUpdate => ({
    ...(start(session) as Extract<ShareViewerMessage, { type: "start" }>),
    seq,
  });

  it("has no cursor until a stored message arrives, then the highest seq", () => {
    expect(apply(readMission()).seq).toBeNull();

    const state = apply(
      readMission(),
      seqStart("a", 1),
      events("a", [[0, "o", "x"]], 2),
      { type: "end", session: "a", seq: 3 },
    );
    expect(state.seq).toBe(3);
  });

  it("applies a message that carries no seq without moving the cursor", () => {
    const state = apply(
      readMission(),
      seqStart("a", 1),
      events("a", [[5, "o", "no seq"]]),
    );

    expect(state.seq).toBe(1);
    expect(state.sessions[0]?.events).toEqual([[5, "o", "no seq"]]);
  });

  it("applies a stored message once, so a segment delivered twice cannot draw twice", () => {
    const segment: ShareUpdate[] = [
      seqStart("a", 1),
      events("a", [[0, "o", "x"]], 2),
    ];
    const first = apply(readMission(), ...segment);
    const again = applyShareMessages(first, segment);

    expect(again.sessions).toHaveLength(1);
    expect(again.sessions[0]?.events).toHaveLength(1);
    expect(again.seq).toBe(2);
  });

  it("takes up where it was when the segments overlap the ones it has", () => {
    const first = apply(
      readMission(),
      seqStart("a", 1),
      events("a", [[0, "o", "one "]], 2),
    );
    // The next read starts a segment early: what is new follows what is old.
    const next = applyShareMessages(first, [
      events("a", [[0, "o", "one "]], 2),
      events("a", [[10, "o", "two"]], 3),
    ]);

    expect(next.sessions[0]?.events.map((event) => event[2]).join("")).toBe(
      "one two",
    );
    expect(next.seq).toBe(3);
  });

  it("treats a seq that is not a number as none", () => {
    const state = apply(readMission(), {
      ...(start("a") as Extract<ShareViewerMessage, { type: "start" }>),
      seq: "7" as unknown as number,
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.seq).toBeNull();
  });
});

describe("grids", () => {
  it("clamps a size the learner's terminal chose", () => {
    expect(clampShareGrid(120, 30)).toEqual({ cols: 120, rows: 30 });
    expect(clampShareGrid(0, 0)).toEqual({ cols: 2, rows: 1 });
    expect(clampShareGrid(1_000_000, 1_000_000)).toEqual({
      cols: SHARE_MAX_CELLS,
      rows: SHARE_MAX_CELLS,
    });
    // Not a number at all: the pre-fit default of the web terminal.
    expect(clampShareGrid(Number.NaN, "wide")).toEqual({ cols: 120, rows: 30 });
    expect(clampShareGrid(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
  });

  it("reads a resize event's data, or nothing", () => {
    expect(parseShareResize("132x34")).toEqual({ cols: 132, rows: 34 });
    expect(parseShareResize("99999999x34")).toBeNull();
    expect(parseShareResize("132 34")).toBeNull();
    expect(parseShareResize("")).toBeNull();
    expect(parseShareResize(42)).toBeNull();
    expect(parseShareResize("5000x5000")).toEqual({
      cols: SHARE_MAX_CELLS,
      rows: SHARE_MAX_CELLS,
    });
  });

  it("clamps the grid a session starts with", () => {
    const state = apply(readMission(), start("a", { cols: 100_000, rows: 0 }));

    expect(state.sessions[0]).toMatchObject({
      cols: SHARE_MAX_CELLS,
      rows: 1,
    });
  });
});

describe("following", () => {
  it("follows the newest terminal that is still running", () => {
    const state = apply(
      readMission(),
      start("a"),
      start("b"),
      start("c"),
      { type: "end", session: "c" },
    );
    expect(followedSession(state.sessions)?.id).toBe("b");

    const detached = applyShareMessages(state, [{ type: "detach", session: "b" }]);
    // A dropped writer may resume, so it still counts as running.
    expect(followedSession(detached.sessions)?.id).toBe("b");
  });

  it("falls back to the newest session when every one has ended", () => {
    const state = apply(
      readMission(),
      start("a"),
      start("b"),
      { type: "end", session: "a" },
      { type: "end", session: "b" },
    );

    expect(followedSession(state.sessions)?.id).toBe("b");
    expect(followedSession([])).toBeNull();
  });
});
