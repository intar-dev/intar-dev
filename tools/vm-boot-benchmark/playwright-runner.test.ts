import { describe, expect, test } from "bun:test";
import {
  freshStartRunId,
  learnerStartRoutePath,
  measureClientRttMs,
  nonEchoNonceCommand,
  observeRemoteTerminalFrames,
  parseRunnerArguments,
  parseStoredBootEvidence,
  scanRemoteTerminalFrame,
  sha256,
  waitForVisibleTerminal,
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
  test("measures the learner client round trip and keeps the fastest sample", async () => {
    const samples = [41, 24, 30];
    let index = 0;
    const page = {
      evaluate: async () => samples[index++] ?? 24,
    };

    const rtt = await measureClientRttMs(page as never, "https://intar.example");

    expect(rtt).toBe(24);
  });

  test("refuses a missing client round trip measurement", async () => {
    const page = { evaluate: async () => Number.NaN };

    await expect(
      measureClientRttMs(page as never, "https://intar.example"),
    ).rejects.toThrow("could not measure the learner client round trip time");
  });

  test("waits for a visible, editable terminal before it reads the clock", async () => {
    const waits: string[] = [];
    let clockRead = false;
    const page = {
      locator: (selector: string) => ({
        first: () => page.locator(selector),
        waitFor: async (options: { state: string }) => {
          waits.push(selector + ":" + options.state);
        },
      }),
      getByRole: (role: string, options: { name: string }) => ({
        waitFor: async (value: { state: string }) => {
          waits.push(role + "[" + options.name + "]:" + value.state);
        },
        isEnabled: async () => true,
      }),
      evaluate: async () => {
        clockRead = true;
        return 1_757_700_000_222;
      },
    };

    const visibleUnixMs = await waitForVisibleTerminal(
      page as never,
      Date.now() + 10_000,
    );

    expect(visibleUnixMs).toBe(1_757_700_000_222);
    expect(clockRead).toBeTrue();
    expect(waits).toContain("[data-scenario-terminal-ready]:visible");
    expect(waits).toContain('[data-terminal-status="connected"]:visible');
    expect(waits).toContain(".xterm:visible");
    expect(waits).toContain("textbox[Terminal input]:visible");
  });

  test("refuses a terminal that is not editable", async () => {
    const page = {
      locator: (selector: string) => ({
        first: () => page.locator(selector),
        waitFor: async () => {},
      }),
      getByRole: () => ({
        waitFor: async () => {},
        isEnabled: async () => false,
      }),
      evaluate: async () => 1,
    };

    await expect(
      waitForVisibleTerminal(page as never, Date.now() + 10_000),
    ).rejects.toThrow("not editable");
  });

  test("refuses a visible mark that is not a browser clock reading", async () => {
    const page = {
      locator: (selector: string) => ({
        first: () => page.locator(selector),
        waitFor: async () => {},
      }),
      getByRole: () => ({
        waitFor: async () => {},
        isEnabled: async () => true,
      }),
      evaluate: async () => Number.NaN,
    };

    await expect(
      waitForVisibleTerminal(page as never, Date.now() + 10_000),
    ).rejects.toThrow("terminal-visible mark");
  });

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

  test("accepts the candidate's own reuse and refuses everything unclear", () => {
    const attemptStart = 1_757_700_000_000;

    // A fresh accept carries the durable acceptance time on the candidate.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: false, runId: "fresh-run", acceptedAt: attemptStart + 120 },
        attemptStart,
        "candidate",
      ),
    ).toEqual({ runId: "fresh-run", acceptedUnixMs: attemptStart + 120, reused: false });

    // An older release reports only the run creation time on a fresh accept.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: false, runId: "old-shape", createdAt: attemptStart + 7 },
        attemptStart,
        "candidate",
      ),
    ).toEqual({ runId: "old-shape", acceptedUnixMs: attemptStart + 7, reused: false });

    // A fresh accept with no timestamp is still this attempt's run, so the page
    // action attributes it and the runner falls back to the browser clock.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: false, runId: "no-time-fresh" },
        attemptStart,
        "candidate",
      ),
    ).toEqual({ runId: "no-time-fresh", acceptedUnixMs: null, reused: false });

    // A candidate transport retry returns reused: true for the run this attempt
    // created. Its durable acceptance time is inside the attempt.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: true, runId: "retry-run", acceptedAt: attemptStart + 5 },
        attemptStart,
        "candidate",
      ),
    ).toEqual({ runId: "retry-run", acceptedUnixMs: attemptStart + 5, reused: true });

    // A run that existed before this attempt is not a fresh sample.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: true, runId: "old-run", acceptedAt: attemptStart - 1 },
        attemptStart,
        "candidate",
      ),
    ).toBeNull();

    // A reused response without a durable acceptance time proves nothing.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: true, runId: "no-time" },
        attemptStart,
        "candidate",
      ),
    ).toBeNull();

    // A missing reused flag is "unknown", not "fresh", on both variants.
    for (const variant of ["baseline", "candidate"] as const) {
      expect(
        freshStartRunId(true, { accepted: true, runId: "no-flag" }, attemptStart, variant),
      ).toBeNull();
      expect(
        freshStartRunId(
          true,
          { accepted: true, reused: "false", runId: "string-flag", acceptedAt: attemptStart + 1 },
          attemptStart,
          variant,
        ),
      ).toBeNull();
    }

    expect(
      freshStartRunId(true, { accepted: true, reused: false, runId: "u" }, attemptStart, "candidate"),
    ).not.toBeNull();
    expect(
      freshStartRunId(
        false,
        { accepted: true, reused: false, runId: "not-ok", acceptedAt: attemptStart + 1 },
        attemptStart,
        "candidate",
      ),
    ).toBeNull();
  });

  test("refuses a reused run on the baseline, whose reuse clock is not durable", () => {
    const attemptStart = 1_757_700_000_000;

    // The baseline reuse path returns Date.now() in the same field, so a reused
    // response looks recent even when the run is old. The variant refuses it.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: true, runId: "baseline-old-run", acceptedAt: attemptStart + 40 },
        attemptStart,
        "baseline",
      ),
    ).toBeNull();
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: true, runId: "baseline-old-run", createdAt: attemptStart - 900 },
        attemptStart,
        "baseline",
      ),
    ).toBeNull();

    // The baseline fresh path carries the durable creation time, so the normal
    // path is accepted and attributed.
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: false, runId: "baseline-fresh", acceptedAt: attemptStart + 12 },
        attemptStart,
        "baseline",
      ),
    ).toEqual({ runId: "baseline-fresh", acceptedUnixMs: attemptStart + 12, reused: false });
    expect(
      freshStartRunId(
        true,
        { accepted: true, reused: false, runId: "baseline-fresh-old-shape", createdAt: attemptStart + 3 },
        attemptStart,
        "baseline",
      ),
    ).toEqual({
      runId: "baseline-fresh-old-shape",
      acceptedUnixMs: attemptStart + 3,
      reused: false,
    });
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
