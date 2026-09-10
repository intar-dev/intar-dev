import { describe, expect, test } from "bun:test";
import {
  freshStartRunId,
  learnerStartRoutePath,
  nonEchoNonceCommand,
  observeRemoteTerminalFrames,
  parseRunnerArguments,
  parseStoredBootEvidence,
  scanRemoteTerminalFrame,
  sha256,
} from "./playwright-runner";

class FakeEventEmitter {
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (value: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeWebSocket extends FakeEventEmitter {
  constructor(private readonly websocketUrl: string) {
    super();
  }

  url() {
    return this.websocketUrl;
  }
}

describe("Playwright VM boot benchmark runner", () => {
  test("encodes a nonce that terminal echo cannot satisfy", () => {
    const nonce = "intar-bench-abc123";
    const command = nonEchoNonceCommand(nonce);

    expect(command).not.toContain(nonce);
    expect(command).toStartWith("printf '");
    const output = Bun.spawnSync(["/bin/sh", "-c", command]);
    expect(new TextDecoder().decode(output.stdout)).toBe(`${nonce}\n`);
    expect(sha256(nonce)).toHaveLength(64);
  });

  test("matches only inbound terminal WebSocket output after split binary frames", () => {
    const nonce = "intar-bench-abc123";
    const command = nonEchoNonceCommand(nonce);
    const commandFrame = scanRemoteTerminalFrame({
      needle: nonce,
      previousTail: "",
      payload: command,
    });
    expect(commandFrame.matches).toBeFalse();

    const first = scanRemoteTerminalFrame({
      needle: nonce,
      previousTail: "",
      payload: `remote: ${nonce.slice(0, 11)}`,
    });
    expect(first.matches).toBeFalse();
    const second = scanRemoteTerminalFrame({
      needle: nonce,
      previousTail: first.nextTail,
      payload: Buffer.from(nonce.slice(11)),
    });
    expect(second.matches).toBeTrue();
  });

  test("requires a successful response that proves a fresh run", () => {
    expect(
      freshStartRunId(true, {
        accepted: true,
        reused: false,
        runId: "fresh-run",
      }),
    ).toBe("fresh-run");
    expect(freshStartRunId(true, { accepted: true, runId: "unknown" })).toBeNull();
    expect(
      freshStartRunId(false, {
        accepted: true,
        reused: false,
        runId: "not-ok",
      }),
    ).toBeNull();
  });

  test("attaches the cached terminal socket after a fast SSH response", async () => {
    const page = new FakeEventEmitter();
    const socket = new FakeWebSocket("wss://terminal.example/session");
    const observer = observeRemoteTerminalFrames(
      page as never,
      "https://intar.example",
    );

    page.emit("response", {
      request: () => ({ method: () => "POST" }),
      url: () => "https://intar.example/api/scenarios/runs/server-run/ssh",
      ok: () => true,
      json: async () => ({
        browser: { websocketUrl: "wss://terminal.example/session" },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    page.emit("websocket", socket);

    observer.expectRun("server-run");
    await observer.waitForSocketListeners(1_000);
    expect(socket.listenerCount("framesent")).toBe(1);
    expect(socket.listenerCount("framereceived")).toBe(1);
    observer.dispose();
  });

  test("keeps only the documented browser timing values", () => {
    expect(
      parseStoredBootEvidence(
        {
          runId: "server-run",
          scenarioId: "broken-nginx",
          startUnixMs: 100,
          terminalConnectedUnixMs: 200,
          token: "must-not-leak",
          stages: { "start-click": 100, "terminal-connected": 200, nope: "bad" },
        },
        "server-run",
        "broken-nginx",
      ),
    ).toEqual({
      runId: "server-run",
      scenarioId: "broken-nginx",
      startUnixMs: 100,
      terminalConnectedUnixMs: 200,
      stages: { "start-click": 100, "terminal-connected": 200 },
    });
  });

  test("requires immutable release labels and a benchmark schedule ID", () => {
    const storageState = import.meta.path;
    const options = parseRunnerArguments([
      "--origin",
      "https://intar.example",
      "--storage-state",
      storageState,
      "--start-page",
      "/courses/fundamentals/lectures/broken-nginx",
      "--scenario-id=broken-nginx",
      "--variant",
      "candidate",
      "--release-id",
      "web-2026-09-10",
      "--release-manifest-sha256",
      "a".repeat(64),
      "--participant-id",
      "participant-1",
      "--run-id",
      "schedule-001",
      "--output",
      "/private/tmp/vm-boot-evidence.json",
    ]);

    expect(options.origin).toBe("https://intar.example");
    expect(options.startPage).toBe("/courses/fundamentals/lectures/broken-nginx");
    expect(options.benchmarkRunId).toBe("schedule-001");
    expect(learnerStartRoutePath("broken/nginx")).toBe(
      "/runs/start/broken%2Fnginx",
    );
  });

  test("accepts only benchmark variants", () => {
    expect(() =>
      parseRunnerArguments([
        "--origin",
        "https://intar.example",
        "--storage-state",
        import.meta.path,
        "--start-page",
        "/courses/fundamentals/lectures/broken-nginx",
        "--scenario-id",
        "broken-nginx",
        "--variant",
        "other",
        "--release-id",
        "release-1",
        "--release-manifest-sha256",
        "a".repeat(64),
        "--participant-id",
        "participant-1",
        "--run-id",
        "schedule-001",
        "--output",
        "/private/tmp/vm-boot-evidence.json",
      ]),
    ).toThrow("--variant must be baseline or candidate");
  });

  test("rejects a start page on another origin", () => {
    expect(() =>
      parseRunnerArguments([
        "--origin",
        "https://intar.example",
        "--storage-state",
        import.meta.path,
        "--start-page",
        "https://other.example/courses/fundamentals",
        "--scenario-id",
        "broken-nginx",
        "--variant",
        "baseline",
        "--release-id",
        "release-1",
        "--release-manifest-sha256",
        "a".repeat(64),
        "--participant-id",
        "participant-1",
        "--run-id",
        "schedule-001",
        "--output",
        "/private/tmp/vm-boot-evidence.json",
      ]),
    ).toThrow("--start-page must be a same-origin path or URL");
  });
});
