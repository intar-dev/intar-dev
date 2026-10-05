import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/control-plane/auth";
import {
  castMessages,
  RUN_SHARE_MAX_LOG_BYTES,
  sharedMatchesRecording,
} from "@/control-plane/run-share-do";
import type {
  ShareHead,
  SharedRunMission,
  ShareViewerMessage,
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

let shareCounter = 0;
function newShareId(): string {
  shareCounter += 1;
  return `share${String(shareCounter).padStart(17, "0")}`;
}

async function initShare() {
  const shareId = newShareId();
  const stub = env.RUN_SHARE.get(env.RUN_SHARE.idFromName(shareId));
  const response = await stub.fetch("https://run-share.internal/init", {
    method: "PUT",
    body: JSON.stringify({
      share_id: shareId,
      mission: MISSION,
      write_token_hash: await sha256Hex(TOKEN),
    }),
  });
  expect(response.status).toBe(204);
  return { stub, shareId };
}

async function producer(stub: DurableObjectStub, token = TOKEN) {
  const response = await stub.fetch("https://run-share.internal/ingest", {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
  });
  const ws = response.webSocket;
  if (response.status !== 101 || !ws) {
    return { status: response.status, ws: null, closed: null };
  }
  const closed = new Promise<{ code: number }>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code }), {
      once: true,
    }),
  );
  ws.accept();
  return { status: 101, ws, closed };
}

async function head(shareId: string): Promise<ShareHead | null> {
  const object = await env.SHARE_LIVE_BUCKET.get(`${shareId}/head.json`);
  return object ? ((await object.json()) as ShareHead) : null;
}

async function segment(
  shareId: string,
  n: number,
  generation = 1,
): Promise<ShareViewerMessage[]> {
  const object = await env.SHARE_LIVE_BUCKET.get(`${shareId}/g${generation}/${n}.jsonl`);
  if (!object) throw new Error(`segment ${n} is missing`);
  return (await object.text())
    .split("\n")
    .map((line) => JSON.parse(line) as ShareViewerMessage);
}

/** Waits until the producer's frames are stored, then publishes a segment. */
async function publish(stub: DurableObjectStub, seq: number): Promise<void> {
  await vi.waitFor(async () => {
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'")
        .toArray()[0]?.value,
    );
    expect(Number(stored ?? 0)).toBeGreaterThanOrEqual(seq);
  });
  await runDurableObjectAlarm(stub);
}

describe("RunShareDO", () => {
  it("publishes the mission and an empty head when sharing starts", async () => {
    const { shareId } = await initShare();
    const mission = await env.SHARE_LIVE_BUCKET.get(`${shareId}/mission.json`);
    expect(await mission?.json()).toEqual(MISSION);
    expect(mission?.httpMetadata?.cacheControl).toBe("public, max-age=3600");
    expect(await head(shareId)).toEqual({ generation: 1, segment: 0, checkpoint: 0, seq: 0, truncated: false, recorded: false });
    const headObject = await env.SHARE_LIVE_BUCKET.get(`${shareId}/head.json`);
    expect(headObject?.httpMetadata?.cacheControl).toBe("public, max-age=1");
  });

  it("refuses writers without the share or with the wrong token", async () => {
    const unknown = env.RUN_SHARE.get(env.RUN_SHARE.idFromName("never-initialized"));
    expect((await producer(unknown)).status).toBe(404);
    const { stub } = await initShare();
    expect(
      (await producer(stub, "bm90LXRoZS1yaWdodC10b2tlbi1hdC1hbGwtcmVhbGx5eA")).status,
    ).toBe(401);
  });

  it("stores each batch once and publishes it as one immutable segment", async () => {
    const { stub, shareId } = await initShare();
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    writer.ws!.send(
      JSON.stringify({
        type: "events",
        events: [[0, "o", "$ "], [120, "o", "l"], [250, "o", "s"]],
      }),
    );
    await publish(stub, 2);

    expect(await head(shareId)).toEqual({ generation: 1, segment: 1, checkpoint: 0, seq: 2, truncated: false, recorded: false });
    expect(await segment(shareId, 1)).toEqual([
      { ...START, resumed: false, seq: 1 },
      {
        type: "events",
        session: SESSION,
        // Each event keeps its own time, so a replay types at the learner's pace.
        events: [[0, "o", "$ "], [120, "o", "l"], [250, "o", "s"]],
        seq: 2,
      },
    ]);
    const object = await env.SHARE_LIVE_BUCKET.get(`${shareId}/g1/1.jsonl`);
    expect(object?.httpMetadata?.cacheControl).toBe("public, max-age=3600");

    writer.ws!.send(JSON.stringify({ type: "events", events: [[400, "o", "\r\n"]] }));
    await publish(stub, 3);
    expect(await head(shareId)).toEqual({ generation: 1, segment: 2, checkpoint: 0, seq: 3, truncated: false, recorded: false });
    expect((await segment(shareId, 2)).map((message) => (message as { seq?: number }).seq)).toEqual([3]);
  });

  it("ends a session on close 1000 and detaches it on any other close", async () => {
    const { stub, shareId } = await initShare();
    const first = await producer(stub);
    first.ws!.send(JSON.stringify(START));
    first.ws!.close(1001, "gateway restart");
    await publish(stub, 2);

    // The writer reconnects and resumes the same session: still one tab.
    const second = await producer(stub);
    second.ws!.send(JSON.stringify({ ...START, mid_session: true }));
    second.ws!.close(1000, "pty ended");
    await publish(stub, 4);

    const messages = [...(await segment(shareId, 1)), ...(await segment(shareId, 2))];
    expect(messages.map((message) => message.type)).toEqual([
      "start",
      "detach",
      "start",
      "end",
    ]);
    expect(messages[2]).toEqual(expect.objectContaining({ resumed: true }));
  });

  it("keeps a resumed session live when the old socket's close arrives late", async () => {
    const { stub, shareId } = await initShare();
    const old = await producer(stub);
    old.ws!.send(JSON.stringify(START));
    await publish(stub, 1);
    const resumed = await producer(stub);
    resumed.ws!.send(JSON.stringify({ ...START, mid_session: true }));
    await publish(stub, 2);
    old.ws!.close(1001, "half-open socket given up");
    resumed.ws!.send(JSON.stringify({ type: "events", events: [[9, "o", "after"]] }));
    await publish(stub, 3);
    expect((await segment(shareId, 3)).map((message) => message.type)).toEqual(["events"]);
  });

  it("clamps geometry from a native client", async () => {
    const { stub, shareId } = await initShare();
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify({ ...START, cols: 65535, rows: 65535 }));
    writer.ws!.send(JSON.stringify({ type: "events", events: [[1, "r", "65535x65535"]] }));
    await publish(stub, 2);
    const [start, events] = await segment(shareId, 1);
    expect(start).toEqual(expect.objectContaining({ cols: 500, rows: 200 }));
    expect(events).toEqual(expect.objectContaining({ events: [[1, "r", "500x200"]] }));
  });

  it("refuses frames out of protocol", async () => {
    const { stub } = await initShare();
    const early = await producer(stub);
    early.ws!.send(JSON.stringify({ type: "events", events: [[0, "o", "x"]] }));
    await expect(early.closed).resolves.toEqual({ code: 1008 });

    const input = await producer(stub);
    input.ws!.send(JSON.stringify(START));
    input.ws!.send(JSON.stringify({ type: "events", events: [[0, "i", "secret"]] }));
    await expect(input.closed).resolves.toEqual({ code: 1008 });
  });

  it("stops publishing output past the storage cap but keeps the tabs right", async () => {
    const { stub, shareId } = await initShare();
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    await publish(stub, 1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE meta SET value = ? WHERE key = 'total'",
        String(RUN_SHARE_MAX_LOG_BYTES - 10),
      );
    });

    writer.ws!.send(JSON.stringify({ type: "events", events: [[1, "o", "over the cap"]] }));
    writer.ws!.send(JSON.stringify({ type: "events", events: [[2, "o", "dropped"]] }));
    writer.ws!.close(1000, "pty ended");
    await publish(stub, 3);
    expect((await segment(shareId, 2)).map((message) => message.type)).toEqual([
      "truncated",
      "end",
    ]);
    expect(await head(shareId)).toEqual(expect.objectContaining({ truncated: true }));
  });

  it("deletes every published file and forgets the share on wipe", async () => {
    const { stub, shareId } = await initShare();
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    await publish(stub, 1);

    const wiped = await stub.fetch("https://run-share.internal/wipe", { method: "POST" });
    expect(wiped.status).toBe(204);
    await expect(writer.closed).resolves.toEqual({ code: 4001 });
    const listing = await env.SHARE_LIVE_BUCKET.list({ prefix: `${shareId}/` });
    expect(listing.objects).toEqual([]);
    expect((await producer(stub)).status).toBe(404);
    // An enable that lost the race to this stop can not bring the share back.
    const late = await stub.fetch("https://run-share.internal/init", {
      method: "PUT",
      body: JSON.stringify({
        share_id: shareId,
        mission: MISSION,
        write_token_hash: await sha256Hex(TOKEN),
      }),
    });
    expect(late.status).toBe(409);
    expect((await env.SHARE_LIVE_BUCKET.list({ prefix: `${shareId}/` })).objects).toEqual([]);
  });

  it("turns a recording into output that keeps the learner's pace", () => {
    const cast = [
      JSON.stringify({ version: 3, term: { cols: 100, rows: 28 }, timestamp: 1 }),
      JSON.stringify([0, "o", "$ "]),
      JSON.stringify([0.12, "i", "l"]),
      JSON.stringify([0.0, "o", "l"]),
      JSON.stringify([0.13, "i", "s"]),
      JSON.stringify([0.0, "o", "s"]),
      JSON.stringify([1.5, "m", "nginx-serves"]),
      JSON.stringify([0.15, "r", "120x30"]),
    ].join("\n");
    const messages = castMessages(cast, {
      id: SESSION,
      vm_id: "vm_01",
      mode: "browser",
      at_ms: 1_000,
    });
    expect(messages).toEqual([
      expect.objectContaining({ type: "start", cols: 100, rows: 28, at_ms: 1_000 }),
      {
        type: "events",
        session: SESSION,
        // Typed input and the check marker are gone; spacing is kept.
        events: [[0, "o", "$ "], [120, "o", "l"], [250, "o", "s"], [1900, "r", "120x30"]],
      },
      { type: "end", session: SESSION },
    ]);
    expect(castMessages('{"version":2}', { id: SESSION, vm_id: "vm_01", mode: "browser", at_ms: 0 })).toBeNull();
  });

  it("matches shared output to a recording only where it continues exactly", () => {
    const prompt = "learner@web:~$ ";
    const work = `${prompt}systemctl status nginx\r\n● nginx.service - A high performance web server\r\n`;
    const recording = `${work}   Active: failed\r\n${prompt}`;
    // sshd's motd comes before kino starts recording; it is skipped.
    expect(sharedMatchesRecording(`Welcome to the lab\r\n${work}`, recording)).toBe(true);
    // Shared output that differs from the recording never matches.
    expect(sharedMatchesRecording(`Welcome\r\n${work.replace("nginx", "sshd")}`, recording)).toBe(false);
    // Too little shared output to tell sessions apart.
    expect(sharedMatchesRecording(prompt, recording)).toBe(false);
  });

  it("writes a checkpoint every 60 segments for late joiners", async () => {
    const { stub, shareId } = await initShare();
    const writer = await producer(stub);
    writer.ws!.send(JSON.stringify(START));
    for (let index = 1; index <= 60; index += 1) {
      writer.ws!.send(JSON.stringify({ type: "events", events: [[index, "o", `line ${index}\r\n`]] }));
      await publish(stub, index + 1);
    }
    expect(await head(shareId)).toEqual(expect.objectContaining({ segment: 60, checkpoint: 1 }));
    const checkpoint = await env.SHARE_LIVE_BUCKET.get(`${shareId}/g1/c1.jsonl`);
    const messages = (await checkpoint!.text()).split("\n").map((line) => JSON.parse(line) as { seq: number });
    expect(messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 61 }, (_, index) => index + 1),
    );
  });

  it("deletes a write that a stop overtook", async () => {
    const { stub, shareId } = await initShare();
    await runInDurableObject(stub, async (instance, state) => {
      const share = instance as unknown as {
        bucket(): R2Bucket;
        putFile(name: string, body: string, type: string, cache: string): Promise<void>;
      };
      const real = env.SHARE_LIVE_BUCKET;
      share.bucket = () =>
        ({
          put: async (...args: Parameters<R2Bucket["put"]>) => {
            const written = await real.put(...args);
            // The stop lands while this write is in flight.
            state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('stopped', '1')");
            return written;
          },
          delete: (keys: string | string[]) => real.delete(keys),
        }) as unknown as R2Bucket;
      await expect(
        share.putFile("g1/9.jsonl", "late", "application/x-ndjson", "public, max-age=3600"),
      ).rejects.toThrow();
    });
    expect(await env.SHARE_LIVE_BUCKET.get(`${shareId}/g1/9.jsonl`)).toBeNull();
  });

  describe("after the run is archived", () => {
    const header = JSON.stringify({ version: 3, term: { cols: 80, rows: 24 }, timestamp: 1 });
    const prompt = "learner@web:~$ ";
    const before = `${prompt}systemctl status nginx\r\n● nginx.service - A high performance web server\r\n`;
    const lost = "   Active: failed (Result: exit-code)\r\n";
    const after = `${prompt}sudo nginx -t\r\n`;

    async function recordings(
      stub: DurableObjectStub,
      shareId: string,
      vmId: string,
      sessions: { start_ms: number; output: [number, string, string][] }[],
    ) {
      const inputs = [];
      for (const [index, session] of sessions.entries()) {
        const key = `${shareId}/${vmId}/${index}-session.cast`;
        await env.VM_RUN_ARTIFACTS_BUCKET.put(
          key,
          [header, ...session.output.map((event) => JSON.stringify(event))].join("\n"),
        );
        inputs.push({ start_ms: session.start_ms, duration_ms: 1_000, cast_key: key });
      }
      const response = await stub.fetch("https://run-share.internal/recording", {
        method: "POST",
        body: JSON.stringify({ vm_id: vmId, sessions: inputs }),
      });
      expect(response.status).toBe(204);
    }

    async function complete(stub: DurableObjectStub, vmId = "vm_01") {
      const response = await stub.fetch("https://run-share.internal/vm-complete", {
        method: "POST",
        body: JSON.stringify({ vm_id: vmId }),
      });
      expect(response.status).toBe(204);
    }

    /** The rebuild runs in an alarm the share sets for right away. */
    async function recorded(shareId: string): Promise<void> {
      await vi.waitFor(async () =>
        expect(await head(shareId)).toEqual(expect.objectContaining({ recorded: true })),
      );
    }

    /** A session shared from its start whose capture lost output to a gap. */
    async function sharedWithHole(stub: DurableObjectStub, start = START) {
      const writer = await producer(stub);
      writer.ws!.send(JSON.stringify(start));
      writer.ws!.send(
        JSON.stringify({ type: "events", events: [[0, "o", `Welcome to the lab\r\n${before}`]] }),
      );
      writer.ws!.send(JSON.stringify({ type: "gap", bytes: lost.length }));
      writer.ws!.send(JSON.stringify({ type: "events", events: [[900, "o", after]] }));
      writer.ws!.close(1000, "pty ended");
      await publish(stub, 5);
    }

    const ownRecording = {
      start_ms: START.at_ms + 800,
      output: [
        [0, "o", before],
        [0.3, "i", "hunter2\r"],
        [0.2, "o", lost],
        [0.4, "o", after],
      ] as [number, string, string][],
    };

    it("fills a hole from the recording that reproduces what was shared", async () => {
      const { stub, shareId } = await initShare();
      await sharedWithHole(stub);
      await recordings(stub, shareId, "vm_01", [
        ownRecording,
        // `ssh vm cat ~/.ssh/id_ed25519` next to it: never published.
        { start_ms: START.at_ms + 200, output: [[0, "o", "-----BEGIN OPENSSH PRIVATE KEY-----\r\n"]] },
      ]);
      await complete(stub);
      await recorded(shareId);

      expect(await head(shareId)).toEqual({
        generation: 2,
        segment: 1,
        checkpoint: 0,
        seq: 3,
        truncated: false,
        recorded: true,
      });
      const [start, events, end] = await segment(shareId, 1, 2);
      expect(start).toEqual(expect.objectContaining({ type: "start", session: SESSION, cols: 80 }));
      expect(events).toEqual({
        type: "events",
        session: SESSION,
        // Typed input stays private; output keeps the recorded spacing.
        events: [[0, "o", before], [500, "o", lost], [900, "o", after]],
        seq: 2,
      });
      expect(end).toEqual({ type: "end", session: SESSION, seq: 3 });
      expect((await env.SHARE_LIVE_BUCKET.list({ prefix: `${shareId}/g1/` })).objects).toEqual([]);
    });

    it("keeps a complete live capture as it was shared", async () => {
      const { stub, shareId } = await initShare();
      const writer = await producer(stub);
      writer.ws!.send(JSON.stringify(START));
      writer.ws!.send(JSON.stringify({ type: "events", events: [[0, "o", before]] }));
      writer.ws!.close(1000, "pty ended");
      await publish(stub, 3);
      await recordings(stub, shareId, "vm_01", [ownRecording]);
      await complete(stub);
      await recorded(shareId);
      expect((await segment(shareId, 1, 2)).map((message) => message.type)).toEqual([
        "start",
        "events",
        "end",
      ]);
      expect((await segment(shareId, 1, 2))[1]).toEqual(
        expect.objectContaining({ events: [[0, "o", before]] }),
      );
    });

    it("keeps the live capture when no recording reproduces it", async () => {
      const { stub, shareId } = await initShare();
      await sharedWithHole(stub);
      await recordings(stub, shareId, "vm_01", [
        { start_ms: START.at_ms + 200, output: [[0, "o", "-----BEGIN OPENSSH PRIVATE KEY-----\r\n".repeat(4)]] },
      ]);
      await complete(stub);
      await recorded(shareId);
      const text = JSON.stringify(await segment(shareId, 1, 2));
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).toContain("Welcome to the lab");
    });

    it("keeps the live capture when two recordings would match", async () => {
      const { stub, shareId } = await initShare();
      await sharedWithHole(stub);
      await recordings(stub, shareId, "vm_01", [
        ownRecording,
        { ...ownRecording, start_ms: START.at_ms + 1_500 },
      ]);
      await complete(stub);
      await recorded(shareId);
      expect(JSON.stringify(await segment(shareId, 1, 2))).not.toContain(lost.trim());
    });

    it("keeps the live capture of a session shared mid-way", async () => {
      const { stub, shareId } = await initShare();
      await sharedWithHole(stub, { ...START, mid_session: true });
      await recordings(stub, shareId, "vm_01", [ownRecording]);
      await complete(stub);
      await recorded(shareId);
      expect(JSON.stringify(await segment(shareId, 1, 2))).not.toContain(lost.trim());
    });

    it("waits for every VM with a shared session, and only those", async () => {
      const { stub, shareId } = await initShare();
      const web = await producer(stub);
      web.ws!.send(JSON.stringify(START));
      const db = await producer(stub);
      db.ws!.send(JSON.stringify({ ...START, session: "db-session", vm_id: "vm_02" }));
      await publish(stub, 2);

      await complete(stub, "vm_03");
      await complete(stub, "vm_01");
      expect(await head(shareId)).toEqual(expect.objectContaining({ generation: 1 }));
      await complete(stub, "vm_02");
      await recorded(shareId);
      // Every session ends once nothing is live anymore.
      expect((await segment(shareId, 1, 2)).filter((message) => message.type === "end")).toHaveLength(2);
    });

    it("ignores recordings delivered again after the rebuild", async () => {
      const { stub, shareId } = await initShare();
      await sharedWithHole(stub);
      await complete(stub);
      await recorded(shareId);
      const rebuilt = await head(shareId);
      await recordings(stub, shareId, "vm_01", [ownRecording]);
      await complete(stub);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await head(shareId)).toEqual(rebuilt);
    });

    it("carries a truncated live capture into the rebuild", async () => {
      const { stub, shareId } = await initShare();
      const writer = await producer(stub);
      writer.ws!.send(JSON.stringify({ ...START, mid_session: true }));
      await publish(stub, 1);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE meta SET value = ? WHERE key = 'total'",
          String(RUN_SHARE_MAX_LOG_BYTES - 10),
        );
      });
      writer.ws!.send(JSON.stringify({ type: "events", events: [[1, "o", "over the cap"]] }));
      writer.ws!.close(1000, "pty ended");
      await publish(stub, 3);
      await complete(stub);
      await recorded(shareId);
      expect(await head(shareId)).toEqual(expect.objectContaining({ truncated: true }));
    });
  });
});
