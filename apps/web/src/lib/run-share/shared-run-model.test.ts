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

const hello = (truncated = false): ShareViewerMessage => ({
  type: "hello",
  mission,
  truncated,
});

function start(
  session: string,
  overrides: Partial<Extract<ShareViewerMessage, { type: "start" }>> = {},
): ShareViewerMessage {
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
): ShareViewerMessage => ({
  type: "events",
  session,
  events: list,
  ...(seq === undefined ? {} : { seq }),
});

function apply(...messages: ShareViewerMessage[]): SharedRunState {
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
      hello(),
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
      hello(),
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
      hello(),
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
      hello(),
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
      hello(),
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
      hello(),
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
    const first = apply(hello(), start("a"), events("a", [[0, "o", "x"]]));
    const frozenEvents = first.sessions[0]!.events;
    const second = applyShareMessages(first, [events("a", [[1, "o", "y"]])]);

    expect(frozenEvents).toHaveLength(1);
    expect(second.sessions[0]?.events).toHaveLength(2);
    expect(second.sessions).not.toBe(first.sessions);
  });

  it("ignores messages for a session it never saw start", () => {
    const state = apply(
      hello(),
      events("ghost", [[0, "o", "x"]]),
      { type: "end", session: "ghost" },
      { type: "gap", session: "ghost", bytes: 1 },
    );

    expect(state.sessions).toEqual([]);
  });

  it("handles a long history without losing an event", () => {
    const messages: ShareViewerMessage[] = [hello(), start("a")];
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
    const messages: ShareViewerMessage[] = [
      hello(),
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
    messages.push({ type: "synced", seq: rows * 2 });

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
    expect(state.synced).toBe(true);
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
    const state = apply(hello(), start("a"), events("a", row));

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
    let state = reduceShareMessage(createSharedRunState(), hello(), copied);
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
    const first = apply(hello(), start("a"), events("a", [[0, "o", "x"]]));
    const second = reduceShareMessage(first, events("a", [[1, "o", "y"]]));
    const third = reduceShareMessage(second, events("a", [[2, "o", "z"]]));

    expect(first.sessions[0]?.events).toHaveLength(1);
    expect(second.sessions[0]?.events).toHaveLength(2);
    expect(third.sessions[0]?.events).toHaveLength(3);
    expect(third.sessions[0]?.events).not.toBe(second.sessions[0]?.events);
  });

  it("starts every batch with its own copy, so an earlier result stays whole", () => {
    const first = applyShareMessages(createSharedRunState(), [
      hello(),
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
      hello(),
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
    for (const link of ["connecting", "reconnecting", "unavailable"] as const) {
      expect(shareSessionPhase(live, link)).toBe("reconnecting");
    }
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
      "reconnecting",
      "stopped",
      "unavailable",
    ];
    for (const link of links) {
      expect(shareSessionPhase(ended, link)).toBe("ended");
    }
  });

  it("is interrupted while a dropped writer may still resume", () => {
    expect(shareSessionPhase(detached, "live")).toBe("interrupted");
    expect(shareSessionPhase(detached, "reconnecting")).toBe("interrupted");
  });
});

describe("truncation and sync", () => {
  it("takes the truncated flag from hello and from a truncated message", () => {
    expect(apply(hello(true)).truncated).toBe(true);
    expect(apply(hello(false)).truncated).toBe(false);
    expect(apply(hello(false), { type: "truncated" }).truncated).toBe(true);
  });

  it("is synced from the synced message until the next hello", () => {
    const state = apply(hello(), start("a"));
    expect(state.synced).toBe(false);

    const synced = applyShareMessages(state, [{ type: "synced", seq: 1 }]);
    expect(synced.synced).toBe(true);
    expect(
      applyShareMessages(synced, [events("a", [[0, "o", "x"]])]).synced,
    ).toBe(true);
    expect(applyShareMessages(synced, [hello()]).synced).toBe(false);
  });

  it("keeps the mission once hello has brought it", () => {
    expect(createSharedRunState().mission).toBeNull();
    expect(apply(hello()).mission).toBe(mission);
  });
});

describe("log sequence and resumed connections", () => {
  const seqStart = (session: string, seq: number): ShareViewerMessage => ({
    ...(start(session) as Extract<ShareViewerMessage, { type: "start" }>),
    seq,
  });

  it("has no cursor until a stored message arrives, then the highest seq", () => {
    expect(apply(hello()).seq).toBeNull();

    const state = apply(
      hello(),
      seqStart("a", 1),
      events("a", [[0, "o", "x"]], 2),
      { type: "end", session: "a", seq: 3 },
    );
    expect(state.seq).toBe(3);
  });

  it("takes the cursor from synced too, never moving it back", () => {
    const state = apply(hello(), seqStart("a", 4), { type: "synced", seq: 9 });
    expect(state.seq).toBe(9);

    const stale = applyShareMessages(state, [{ type: "synced", seq: 5 }]);
    expect(stale.seq).toBe(9);
  });

  it("applies live output that carries no seq without moving the cursor", () => {
    const state = apply(
      hello(),
      seqStart("a", 1),
      { type: "synced", seq: 1 },
      events("a", [[5, "o", "past the cap"]]),
    );

    expect(state.seq).toBe(1);
    expect(state.sessions[0]?.events).toEqual([[5, "o", "past the cap"]]);
  });

  it("applies a stored message once, so a repeat cannot draw twice", () => {
    const first = apply(
      hello(),
      seqStart("a", 1),
      events("a", [[0, "o", "x"]], 2),
    );
    const again = applyShareMessages(first, [
      seqStart("a", 1),
      events("a", [[0, "o", "x"]], 2),
    ]);

    expect(again.sessions).toHaveLength(1);
    expect(again.sessions[0]?.events).toHaveLength(1);
    expect(again.seq).toBe(2);
  });

  it("treats a seq that is not a number as none", () => {
    const state = apply(
      hello(),
      {
        ...(start("a") as Extract<ShareViewerMessage, { type: "start" }>),
        seq: "7" as unknown as number,
      },
      { type: "synced", seq: undefined as unknown as number },
    );

    expect(state.sessions).toHaveLength(1);
    expect(state.synced).toBe(true);
    expect(state.seq).toBeNull();
  });

  it("keeps its sessions when a resumed connection says hello again", () => {
    const before = apply(
      hello(),
      seqStart("a", 1),
      events("a", [[0, "o", "kept"]], 2),
      seqStart("b", 3),
      { type: "synced", seq: 3 },
    );

    const refreshed: SharedRunMission = { ...mission, title: "Renamed" };
    const after = applyShareMessages(before, [
      { type: "hello", mission: refreshed, truncated: true },
      events("a", [[10, "o", " and more"]], 4),
      { type: "end", session: "b", seq: 5 },
      { type: "synced", seq: 5 },
    ]);

    expect(after.mission).toBe(refreshed);
    expect(after.truncated).toBe(true);
    expect(after.sessions.map((session) => session.id)).toEqual(["a", "b"]);
    expect(
      after.sessions[0]?.events.map((event) => event[2]).join(""),
    ).toBe("kept and more");
    expect(after.sessions[1]?.status).toBe("ended");
    expect(after.synced).toBe(true);
    expect(after.seq).toBe(5);
  });

  it("is not synced between the new hello and the new synced", () => {
    const before = apply(hello(), seqStart("a", 1), { type: "synced", seq: 1 });
    const resumed = applyShareMessages(before, [hello()]);

    expect(resumed.synced).toBe(false);
    expect(resumed.sessions).toHaveLength(1);
    expect(resumed.seq).toBe(1);
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
    const state = apply(hello(), start("a", { cols: 100_000, rows: 0 }));

    expect(state.sessions[0]).toMatchObject({
      cols: SHARE_MAX_CELLS,
      rows: 1,
    });
  });
});

describe("following", () => {
  it("follows the newest terminal that is still running", () => {
    const state = apply(
      hello(),
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
      hello(),
      start("a"),
      start("b"),
      { type: "end", session: "a" },
      { type: "end", session: "b" },
    );

    expect(followedSession(state.sessions)?.id).toBe("b");
    expect(followedSession([])).toBeNull();
  });
});
