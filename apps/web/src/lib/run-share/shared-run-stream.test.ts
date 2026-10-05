import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareViewerMessage } from "./protocol";
import {
  SHARE_HANDSHAKE_FAILURES,
  SHARE_PING_INTERVAL_MS,
  connectShareStream,
  shareReconnectDelay,
  shareStreamUrl,
  type ShareConnection,
} from "./shared-run-stream";

const SHARE_ID = "Zm9vYmFyYmF6cXV4cXV1eA";
const ORIGIN = "https://intar.example.test";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];
  closedWith: number | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.closedWith = code;
  }

  open() {
    this.onopen?.({} as Event);
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  drop(code = 1006) {
    this.onclose?.({ code } as CloseEvent);
  }
}

function frame(...messages: ShareViewerMessage[]) {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

const hello: ShareViewerMessage = {
  type: "hello",
  truncated: false,
  mission: {
    title: "t",
    tagline: "",
    scenario_name: "s",
    lecture_title: null,
    markdown: "",
    objectives: [],
    vms: [],
  },
};

function connect(after: () => number | null = () => null) {
  const states: ShareConnection[] = [];
  const messages: ShareViewerMessage[][] = [];
  const stream = connectShareStream({
    shareId: SHARE_ID,
    origin: ORIGIN,
    after,
    onMessages: (batch) => messages.push(batch),
    onConnection: (state) => states.push(state),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    // The middle of the jitter, so a delay is its base.
    random: () => 0.5,
  });
  return { stream, states, messages };
}

const sockets = () => FakeSocket.instances;
const last = () => FakeSocket.instances.at(-1)!;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the viewer socket", () => {
  it("asks for the share by its id and reads every message of a frame", () => {
    const { messages, states } = connect();

    expect(sockets()).toHaveLength(1);
    expect(last().url).toBe(
      `wss://intar.example.test/api/shares/stream?s=${SHARE_ID}`,
    );
    last().open();
    last().receive(
      frame(hello, { type: "events", session: "a", events: [[0, "o", "x"]] }),
    );

    expect(states).toEqual(["open"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.map((message) => message.type)).toEqual([
      "hello",
      "events",
    ]);
  });

  it("builds a ws address from an http origin and adds the cursor", () => {
    expect(shareStreamUrl("http://127.0.0.1:4330", SHARE_ID, 12)).toBe(
      `ws://127.0.0.1:4330/api/shares/stream?s=${SHARE_ID}&after=12`,
    );
    expect(shareStreamUrl(ORIGIN, SHARE_ID, 0)).toContain("&after=0");
  });

  it("skips what it cannot read and what is only a pong", () => {
    const { messages, states } = connect();
    last().open();
    last().receive("pong");
    last().receive("{not json");
    last().receive(new ArrayBuffer(4));
    last().receive(frame(hello));

    expect(states).toEqual(["open"]);
    expect(messages).toHaveLength(1);
  });

  it("ends for good when the share is stopped (4001)", () => {
    const { states } = connect();
    last().open();
    last().drop(4001);
    vi.advanceTimersByTime(10 * 60_000);

    expect(states).toEqual(["open", "stopped"]);
    expect(sockets()).toHaveLength(1);
  });

  it("retries a first connection that fails, like any other", () => {
    const { states } = connect();
    // Never opened: the upgrade was refused (a 429, a 503, a network blip).
    last().drop(1006);

    expect(states).toEqual(["reconnecting"]);
    vi.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(2);
    // The share is asked for from the start again: nothing was received.
    expect(last().url).toBe(
      `wss://intar.example.test/api/shares/stream?s=${SHARE_ID}`,
    );
    last().open();
    expect(states).toEqual(["reconnecting", "open"]);
  });

  it("calls the share unavailable after a run of failed handshakes, the first connection included", () => {
    const { states } = connect();
    const started = Date.now();
    const waits: number[] = [];
    // The backoff between refusals: one second, doubling.
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      last().drop(1006);
      expect(states.at(-1)).toBe("reconnecting");
      const before = Date.now();
      vi.advanceTimersToNextTimer();
      waits.push(Date.now() - before);
      expect(sockets()).toHaveLength(failed + 1);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);

    last().drop(1006);
    expect(states.at(-1)).toBe("unavailable");
    // About half a minute of trying, and nothing after it.
    expect(Date.now() - started).toBe(31_000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets()).toHaveLength(SHARE_HANDSHAKE_FAILURES);
    expect(states.filter((state) => state === "unavailable")).toHaveLength(1);
  });

  it("starts the count over when the viewer tries again", () => {
    const { stream, states } = connect();
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      last().drop(1006);
      vi.advanceTimersToNextTimer();
    }
    last().drop(1006);
    expect(states.at(-1)).toBe("unavailable");

    stream.retry();
    expect(sockets()).toHaveLength(SHARE_HANDSHAKE_FAILURES + 1);
    last().drop(1006);
    // One refusal is not the end again.
    expect(states.at(-1)).toBe("reconnecting");
    vi.advanceTimersToNextTimer();
    last().open();
    expect(states.at(-1)).toBe("open");
  });

  it("clears the refusals before it once a connection gets through", () => {
    const { states } = connect();
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      last().drop(1006);
      vi.advanceTimersToNextTimer();
    }
    // The last attempt before the limit gets through, then drops.
    last().open();
    last().drop(1006);
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      vi.advanceTimersToNextTimer();
      last().drop(1006);
    }

    expect(states.at(-1)).toBe("reconnecting");
    expect(states).not.toContain("unavailable");
  });

  it("treats an address the browser refuses as nothing to wait for", () => {
    const states: ShareConnection[] = [];
    connectShareStream({
      shareId: SHARE_ID,
      origin: ORIGIN,
      after: () => null,
      onMessages: () => undefined,
      onConnection: (state) => states.push(state),
      createSocket: () => {
        throw new SyntaxError("bad url");
      },
    });
    // No handshake was tried, so there is no run of them to count.
    vi.advanceTimersByTime(10 * 60_000);

    expect(states).toEqual(["unavailable"]);
  });

  it("reconnects after a drop and asks only for what it missed", () => {
    let seq: number | null = null;
    const { states } = connect(() => seq);
    last().open();
    last().receive(frame(hello, { type: "synced", seq: 41 }));
    seq = 41;
    last().drop(1001);

    expect(states).toEqual(["open", "reconnecting"]);
    // The first retry is one second away, to the millisecond with no jitter.
    vi.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(2);
    expect(last().url).toBe(
      `wss://intar.example.test/api/shares/stream?s=${SHARE_ID}&after=41`,
    );

    last().open();
    expect(states).toEqual(["open", "reconnecting", "open"]);
  });

  it("backs off while attempts fail, up to thirty seconds, and starts over once synced", () => {
    const { states } = connect();
    last().open();
    const delays: number[] = [];
    // A server that accepts and drops, never reaching synced.
    for (let round = 0; round < 8; round += 1) {
      const started = Date.now();
      last().drop(1011);
      // The only timer left is the one that reconnects.
      vi.advanceTimersToNextTimer();
      delays.push(Date.now() - started);
      expect(sockets()).toHaveLength(round + 2);
      last().open();
    }
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);

    last().receive(frame(hello, { type: "synced", seq: 1 }));
    last().drop(1011);
    vi.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(9);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(10);
    expect(states.filter((state) => state === "reconnecting")).toHaveLength(9);
  });

  it("keeps trying when a reconnect fails its handshake after it once worked", () => {
    const { states } = connect();
    last().open();
    last().drop(1006);
    vi.advanceTimersByTime(1_000);
    // This attempt never opens (the network is down).
    last().drop(1006);
    vi.advanceTimersByTime(2_000);

    expect(states).toEqual(["open", "reconnecting", "reconnecting"]);
    expect(sockets()).toHaveLength(3);
  });

  it("calls a share that worked unavailable too once its reconnects keep failing", () => {
    const { stream, states } = connect();
    last().open();
    last().drop(1006);
    // Reconnects that never open keep trying, up to the limit.
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      vi.advanceTimersToNextTimer();
      expect(sockets()).toHaveLength(failed + 1);
      last().drop(1006);
      expect(states.at(-1)).toBe("reconnecting");
    }
    // The next one ends it, and nothing reconnects after.
    vi.advanceTimersToNextTimer();
    last().drop(1006);
    expect(states.at(-1)).toBe("unavailable");
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets()).toHaveLength(SHARE_HANDSHAKE_FAILURES + 1);

    // Try again starts the count over.
    stream.retry();
    last().drop(1006);
    expect(states.at(-1)).toBe("reconnecting");
  });

  it("counts failed handshakes afresh once a reconnect opens", () => {
    const { states } = connect();
    last().open();
    last().drop(1006);
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      vi.advanceTimersToNextTimer();
      last().drop(1006);
    }
    // One that gets through, then drops, clears the count.
    vi.advanceTimersToNextTimer();
    last().open();
    last().drop(1006);
    for (let failed = 1; failed < SHARE_HANDSHAKE_FAILURES; failed += 1) {
      vi.advanceTimersToNextTimer();
      last().drop(1006);
    }

    expect(states.at(-1)).toBe("reconnecting");
    expect(states).not.toContain("unavailable");
  });

  it("jitters the delay by 30% either way", () => {
    expect(shareReconnectDelay(0, 0)).toBe(700);
    expect(shareReconnectDelay(0, 0.5)).toBe(1_000);
    expect(shareReconnectDelay(0, 1)).toBe(1_300);
    expect(shareReconnectDelay(3, 0.5)).toBe(8_000);
    expect(shareReconnectDelay(20, 0.5)).toBe(30_000);
    expect(shareReconnectDelay(20, 0)).toBe(21_000);
    expect(shareReconnectDelay(20, 1)).toBe(39_000);
    expect(shareReconnectDelay(5_000, 0.5)).toBe(30_000);
  });

  it("pings every thirty seconds and leaves a peer that stops answering", () => {
    const { states } = connect();
    last().open();

    vi.advanceTimersByTime(SHARE_PING_INTERVAL_MS);
    expect(last().sent).toEqual(["ping"]);
    last().receive("pong");
    vi.advanceTimersByTime(SHARE_PING_INTERVAL_MS);
    expect(last().sent).toEqual(["ping", "ping"]);

    // No pong, no frame: the next tick gives up on this socket.
    const silent = last();
    vi.advanceTimersByTime(SHARE_PING_INTERVAL_MS);
    expect(states).toEqual(["open", "reconnecting"]);
    expect(silent.closedWith).toBe(1000);
    vi.advanceTimersByTime(1_000);
    expect(sockets()).toHaveLength(2);
  });

  it("counts any frame as proof the peer is alive", () => {
    const { states } = connect();
    last().open();
    vi.advanceTimersByTime(SHARE_PING_INTERVAL_MS);
    last().receive(frame({ type: "gap", session: "a", bytes: 1 }));
    vi.advanceTimersByTime(SHARE_PING_INTERVAL_MS);

    expect(states).toEqual(["open"]);
    expect(last().sent).toEqual(["ping", "ping"]);
  });

  it("stops everything when closed", () => {
    const { stream, states, messages } = connect();
    last().open();
    const socket = last();
    stream.close();

    expect(socket.closedWith).toBe(1000);
    // Whatever the socket still delivers is not heard.
    socket.receive(frame(hello));
    socket.drop(1006);
    vi.advanceTimersByTime(10 * 60_000);

    expect(states).toEqual(["open"]);
    expect(messages).toEqual([]);
    expect(sockets()).toHaveLength(1);
  });

  it("does not reconnect from a pending retry once closed", () => {
    const { stream } = connect();
    last().open();
    last().drop(1006);
    stream.close();
    vi.advanceTimersByTime(60_000);

    expect(sockets()).toHaveLength(1);
  });
});
