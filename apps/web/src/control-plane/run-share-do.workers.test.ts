import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/control-plane/auth";
import {
  RUN_SHARE_HISTORY_FRAME_BYTES,
  RUN_SHARE_MAX_LOG_BYTES,
  RUN_SHARE_MAX_VIEWERS_PER_NETWORK,
} from "@/control-plane/run-share-do";
import {
  parseShareViewerFrame,
  type SharedRunMission,
  type ShareViewerMessage,
} from "@/lib/run-share/protocol";

const TOKEN = "c2VjcmV0LXdyaXRlLXRva2VuLWZvci10aGUtc2hhcmU";
const SESSION = "5f1c9d2a-6b1e-4f43-9a51-2f8a7c3e9b10";
const MISSION: SharedRunMission = {
  title: "Fix the web server",
  tagline: "nginx answers 502",
  scenario_name: "nginx-502",
  lecture_title: null,
  markdown: "Find out why **nginx** answers 502.",
  objectives: [
    { vm_name: "web", label: "nginx serves", title: null, body_markdown: null },
  ],
  vms: [{ id: "vm_01", name: "web" }],
};
const START = {
  type: "start",
  session: SESSION,
  vm_id: "vm_01",
  mode: "browser",
  cols: 120,
  rows: 30,
  at_ms: 1_791_187_200_000,
  mid_session: false,
};

function share(name: string) {
  return env.RUN_SHARE.get(env.RUN_SHARE.idFromName(name));
}

async function initShare(name: string) {
  const stub = share(name);
  const response = await stub.fetch("https://run-share.internal/init", {
    method: "PUT",
    body: JSON.stringify({
      mission: MISSION,
      write_token_hash: await sha256Hex(TOKEN),
    }),
  });
  expect(response.status).toBe(204);
  return stub;
}

const NETWORK = "a".repeat(24);

async function connect(
  stub: DurableObjectStub,
  path: string,
  headers: Record<string, string> = {},
) {
  const response = await stub.fetch(`https://run-share.internal${path}`, {
    headers: {
      upgrade: "websocket",
      ...(path.startsWith("/watch") ? { "x-share-viewer-network": NETWORK } : {}),
      ...headers,
    },
  });
  const ws = response.webSocket;
  if (response.status !== 101 || !ws) {
    return { status: response.status, ws: null, frames: [], closed: null };
  }
  const frames: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    ),
  );
  ws.accept();
  ws.addEventListener("message", (event) => {
    frames.push(String(event.data));
  });
  return { status: 101, ws, frames, closed };
}

const producer = (stub: DurableObjectStub) =>
  connect(stub, "/ingest", { authorization: `Bearer ${TOKEN}` });

function messages(frames: string[]): ShareViewerMessage[] {
  return frames.flatMap(parseShareViewerFrame);
}

function types(frames: string[]): string[] {
  return messages(frames).map((message) => message.type);
}

describe("RunShareDO", () => {
  it("refuses viewers and writers until the share is initialized", async () => {
    const stub = share("uninitialized");
    expect((await connect(stub, "/watch")).status).toBe(404);
    expect((await producer(stub)).status).toBe(404);
  });

  it("refuses a writer with the wrong token", async () => {
    const stub = await initShare("wrong-token");
    const response = await connect(stub, "/ingest", {
      authorization: "Bearer bm90LXRoZS1yaWdodC10b2tlbi1hdC1hbGwtcmVhbGx5eA",
    });
    expect(response.status).toBe(401);
    expect((await connect(stub, "/ingest")).status).toBe(401);
  });

  it("stores each batch once, sends history to new viewers and pushes live", async () => {
    const stub = await initShare("history-then-live");
    const early = await connect(stub, "/watch");
    await vi.waitFor(() => expect(types(early.frames)).toEqual(["hello", "synced"]));
    expect(messages(early.frames)[0]).toEqual({
      type: "hello",
      mission: MISSION,
      truncated: false,
    });

    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    writer.ws!.send(
      JSON.stringify({ type: "events", events: [[0, "o", "$ "], [5, "r", "80x24"]] }),
    );
    await vi.waitFor(() =>
      expect(types(early.frames)).toEqual(["hello", "synced", "start", "events"]),
    );
    expect(messages(early.frames).slice(2)).toEqual([
      { ...START, cols: 120, resumed: false, seq: 1 },
      {
        type: "events",
        session: SESSION,
        events: [[0, "o", "$ "], [5, "r", "80x24"]],
        seq: 2,
      },
    ]);

    const late = await connect(stub, "/watch");
    await vi.waitFor(() =>
      expect(types(late.frames)).toEqual(["hello", "start", "events", "synced"]),
    );
    expect(messages(late.frames).at(-1)).toEqual({ type: "synced", seq: 2 });

    const resumed = await connect(stub, "/watch?after=1");
    await vi.waitFor(() =>
      expect(types(resumed.frames)).toEqual(["hello", "events", "synced"]),
    );
  });

  it("coalesces history into bounded frames", async () => {
    const stub = await initShare("coalesced-history");
    const live = await connect(stub, "/watch");
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    const chunk = "x".repeat(100 * 1024);
    for (let index = 0; index < 12; index += 1) {
      writer.ws!.send(JSON.stringify({ type: "events", events: [[index, "o", chunk]] }));
    }
    await vi.waitFor(() =>
      expect(types(live.frames).filter((type) => type === "events")).toHaveLength(12),
    );

    const viewer = await connect(stub, "/watch");
    await vi.waitFor(() => expect(types(viewer.frames).at(-1)).toBe("synced"));
    expect(types(viewer.frames).filter((type) => type === "events")).toHaveLength(12);
    // 12 x 100 KiB of output in 512 KiB frames: several messages per frame.
    expect(viewer.frames.length).toBeGreaterThan(1);
    expect(viewer.frames.length).toBeLessThan(6);
    for (const frame of viewer.frames) {
      expect(frame.length).toBeLessThanOrEqual(RUN_SHARE_HISTORY_FRAME_BYTES);
    }
  });

  it("ends a session on close 1000 and detaches it on any other close", async () => {
    const stub = await initShare("end-and-detach");
    const viewer = await connect(stub, "/watch");

    const first = await producer(stub);
    first.ws!.send(JSON.stringify(START));
    await vi.waitFor(() => expect(types(viewer.frames)).toContain("start"));
    first.ws!.close(1001, "gateway restart");
    await vi.waitFor(() => expect(types(viewer.frames)).toContain("detach"));

    // The writer reconnects and resumes the same session: still one tab.
    const second = await producer(stub);
    second.ws!.send(JSON.stringify({ ...START, mid_session: true }));
    await vi.waitFor(() =>
      expect(messages(viewer.frames).filter((message) => message.type === "start")).toEqual([
        expect.objectContaining({ resumed: false }),
        expect.objectContaining({ resumed: true, mid_session: true }),
      ]),
    );
    second.ws!.close(1000, "pty ended");
    await vi.waitFor(() =>
      expect(messages(viewer.frames).at(-1)).toEqual(
        expect.objectContaining({ type: "end", session: SESSION }),
      ),
    );
  });

  it("keeps a resumed session live when the old socket's close arrives late", async () => {
    const stub = await initShare("late-close");
    const viewer = await connect(stub, "/watch");
    const old = await producer(stub);
    old.ws!.send(JSON.stringify(START));
    await vi.waitFor(() => expect(types(viewer.frames)).toContain("start"));

    const resumed = await producer(stub);
    resumed.ws!.send(JSON.stringify({ ...START, mid_session: true }));
    await vi.waitFor(() =>
      expect(types(viewer.frames).filter((type) => type === "start")).toHaveLength(2),
    );
    old.ws!.close(1001, "half-open socket given up");
    resumed.ws!.send(JSON.stringify({ type: "events", events: [[9, "o", "after"]] }));
    await vi.waitFor(() => expect(types(viewer.frames).at(-1)).toBe("events"));
    expect(types(viewer.frames)).not.toContain("detach");
  });

  it("caps the viewers of one network, not of everyone", async () => {
    const stub = await initShare("per-network-cap");
    for (let index = 0; index < RUN_SHARE_MAX_VIEWERS_PER_NETWORK; index += 1) {
      expect((await connect(stub, "/watch")).status).toBe(101);
    }
    expect((await connect(stub, "/watch")).status).toBe(503);
    expect(
      (await connect(stub, "/watch", { "x-share-viewer-network": "b".repeat(24) }))
        .status,
    ).toBe(101);
    expect(
      (await connect(stub, "/watch", { "x-share-viewer-network": "not hex" })).status,
    ).toBe(400);
  });

  it("clamps geometry from a native client", async () => {
    const stub = await initShare("clamped-geometry");
    const viewer = await connect(stub, "/watch");
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify({ ...START, cols: 65535, rows: 65535 }));
    writer.ws!.send(
      JSON.stringify({ type: "events", events: [[1, "r", "65535x65535"]] }),
    );
    await vi.waitFor(() => expect(types(viewer.frames)).toContain("events"));
    const [start, events] = messages(viewer.frames).slice(-2);
    expect(start).toEqual(expect.objectContaining({ cols: 500, rows: 200 }));
    expect(events).toEqual(expect.objectContaining({ events: [[1, "r", "500x200"]] }));
  });

  it("refuses frames out of protocol", async () => {
    const stub = await initShare("protocol-errors");
    const early = await producer(stub);
    early.ws!.send(JSON.stringify({ type: "events", events: [[0, "o", "x"]] }));
    await expect(early.closed).resolves.toEqual(
      expect.objectContaining({ code: 1008 }),
    );

    const input = await producer(stub);
    input.ws!.send(JSON.stringify(START));
    input.ws!.send(JSON.stringify({ type: "events", events: [[0, "i", "secret"]] }));
    await expect(input.closed).resolves.toEqual(
      expect.objectContaining({ code: 1008 }),
    );

    const viewer = await connect(stub, "/watch");
    viewer.ws!.send("hello?");
    await expect(viewer.closed).resolves.toEqual(
      expect.objectContaining({ code: 1003 }),
    );
  });

  it("keeps broadcasting past the storage cap but stops storing output", async () => {
    const stub = await initShare("truncated");
    const viewer = await connect(stub, "/watch");
    await vi.waitFor(() => expect(types(viewer.frames)).toEqual(["hello", "synced"]));
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    await vi.waitFor(() => expect(types(viewer.frames)).toContain("start"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE log SET total = ? WHERE seq = (SELECT max(seq) FROM log)`,
        RUN_SHARE_MAX_LOG_BYTES - 10,
      );
    });

    writer.ws!.send(JSON.stringify({ type: "events", events: [[1, "o", "over the cap"]] }));
    writer.ws!.send(JSON.stringify({ type: "events", events: [[2, "o", "still live"]] }));
    await vi.waitFor(() =>
      expect(types(viewer.frames)).toEqual([
        "hello",
        "synced",
        "start",
        "truncated",
        "events",
        "events",
      ]),
    );
    expect(messages(viewer.frames).slice(-2).map((message) => "seq" in message)).toEqual([
      false,
      false,
    ]);

    const late = await connect(stub, "/watch");
    await vi.waitFor(() => expect(types(late.frames).at(-1)).toBe("synced"));
    expect(messages(late.frames)[0]).toEqual(
      expect.objectContaining({ type: "hello", truncated: true }),
    );
    expect(types(late.frames)).toEqual(["hello", "start", "truncated", "synced"]);
  });

  it("closes everyone and forgets the log on wipe", async () => {
    const stub = await initShare("wiped");
    const viewer = await connect(stub, "/watch");
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    await vi.waitFor(() => expect(types(viewer.frames)).toContain("start"));

    const wiped = await stub.fetch("https://run-share.internal/wipe", { method: "POST" });
    expect(wiped.status).toBe(204);
    await expect(viewer.closed).resolves.toEqual(
      expect.objectContaining({ code: 4001 }),
    );
    await expect(writer.closed).resolves.toEqual(
      expect.objectContaining({ code: 4001 }),
    );
    expect((await connect(stub, "/watch")).status).toBe(404);
    expect((await producer(stub)).status).toBe(404);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM log").one()).toEqual({ n: 0 });
    });
  });
});
