import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { FIXED_NOW } from "./fixtures/data";
import { routeCase } from "./routes";

type TerminalControl = {
  type: "open" | "resize" | "close";
  cols?: number;
  rows?: number;
};

async function captureTerminalControls(page: Page) {
  const controls: TerminalControl[] = [];
  let closed = false;
  await page.routeWebSocket("ws://terminal.example.test/terminal/**", (ws) => {
    ws.onClose(() => {
      closed = true;
    });
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let control: TerminalControl;
      try {
        control = JSON.parse(message) as TerminalControl;
      } catch {
        return;
      }
      if (
        control.type !== "open" &&
        control.type !== "resize" &&
        control.type !== "close"
      ) {
        return;
      }
      controls.push(control);
      if (control.type === "open") {
        ws.send(JSON.stringify({ type: "ready" }));
      }
    });
  });
  return { controls, isClosed: () => closed };
}

test("a lecture start click records terminal-start evidence", async ({ page, ui }) => {
  ui.configure({ sessionRole: "learner", runState: "archived" });
  const course = ui.server.state.courseCatalog[0]!;
  const lecture = course.lectures[1]!;
  lecture.state = "available";
  lecture.activeRunId = null;
  lecture.scenarioReady = true;
  let startRequests = 0;
  await page.route("**/api/scenarios/repair-nginx/start", async (route) => {
    startRequests += 1;
    ui.server.setRunState("running");
    await route.fulfill({
      status: 202,
      json: {
        accepted: true,
        runId: "run-active",
        scenarioId: "repair-nginx",
        acceptedAt: FIXED_NOW,
        reused: false,
        run: ui.server.state.run,
      },
    });
  });

  await page.goto(`/courses/${course.courseId}/lectures/${lecture.lectureId}`, {
    waitUntil: "domcontentloaded",
  });
  await ui.settle();
  const startResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scenarios/repair-nginx/start") &&
      response.status() === 202,
  );
  await page.getByRole("button", { name: "Start scenario" }).click();
  await startResponse;
  await expect(page).toHaveURL("/runs/run-active");
  await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("intar:vm-boot:run-active");
        return raw ? (JSON.parse(raw).stages?.["terminal-connected"] ?? 0) : 0;
      }),
    )
    .toBeGreaterThan(0);
  const evidence = await page.evaluate(() => {
    const raw = sessionStorage.getItem("intar:vm-boot:run-active");
    return raw ? JSON.parse(raw) : null;
  }) as {
    runId: string;
    scenarioId: string;
    startUnixMs: number;
    stages: Record<string, number>;
  } | null;
  expect(evidence).not.toBeNull();
  expect(evidence).toMatchObject({
    runId: "run-active",
    scenarioId: "repair-nginx",
  });
  expect(evidence!.stages["start-click"]).toBe(evidence!.startUnixMs);
  expect(evidence!.stages["start-request"]).toBeGreaterThanOrEqual(
    evidence!.startUnixMs,
  );
  expect(evidence!.stages["terminal-connected"]).toBeGreaterThanOrEqual(
    evidence!.startUnixMs,
  );
  expect(startRequests).toBe(1);
});

test("startup notifications survive phase changes and close when the terminal is ready", async ({ page, ui }) => {
  const sockets: WebSocketRoute[] = [];
  let closed = 0;
  await page.routeWebSocket(/\/api\/scenarios\/runs\/[^/]+\/status\/stream$/, (ws) => {
    sockets.push(ws);
    ws.onClose(() => { closed += 1; });
    ws.send(JSON.stringify({ type: "subscribed", runId: "run-active" }));
  });
  await ui.open({ ...routeCase("run-workspace"), runState: "launching" });
  await expect.poll(() => sockets.length).toBe(1);

  for (const state of ["booting", "waiting"] as const) {
    ui.server.setRunState(state);
    const response = page.waitForResponse((value) =>
      /\/api\/scenarios\/runs\/run-active\/status(?:\?|$)/.test(value.url()) && value.status() === 200,
    );
    sockets[0]!.send(JSON.stringify({
      type: "invalidate",
      runId: "run-active",
      revision: Number(ui.server.state.run.updatedAt) + ui.server.scenarioRunStatusRevision,
    }));
    await response;
    expect(sockets).toHaveLength(1);
    expect(closed).toBe(0);
  }

  ui.server.setRunState("running");
  const readyResponse = page.waitForResponse((value) =>
    /\/api\/scenarios\/runs\/run-active\/status(?:\?|$)/.test(value.url()) && value.status() === 200,
  );
  sockets[0]!.send(JSON.stringify({
    type: "invalidate",
    runId: "run-active",
    revision: Number(ui.server.state.run.updatedAt) + ui.server.scenarioRunStatusRevision,
  }));
  await readyResponse;
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(() => closed).toBe(1);
});

test("the status socket closes in the background and reconnects once when visible", async ({
  page,
  ui,
}) => {
  await page.addInitScript(() => {
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.assign(window, {
      setIntarTestVisibility: (next: DocumentVisibilityState) => {
        state = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  });
  const sockets: WebSocketRoute[] = [];
  let closed = 0;
  await page.routeWebSocket(/\/api\/scenarios\/runs\/[^/]+\/status\/stream$/, (ws) => {
    sockets.push(ws);
    ws.onClose(() => {
      closed += 1;
    });
  });
  // Hold the terminal target pending for the whole test. The run projection
  // reports a pending terminal, so the shell must stay hidden: this test is
  // about the status socket, and it must not depend on terminal visibility.
  const pendingTerminals: WebSocketRoute[] = [];
  await page.routeWebSocket("ws://terminal.example.test/terminal/**", (ws) => {
    pendingTerminals.push(ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      try {
        const control = JSON.parse(message) as TerminalControl;
        // No ready answer is sent: the gateway handshake never completes.
        if (control.type === "open") return;
      } catch {
        // Binary frames are terminal input and are ignored here.
      }
    });
  });
  await ui.open({ ...routeCase("run-workspace"), runState: "launching" });
  await expect.poll(() => sockets.length).toBe(1);

  await page.evaluate(() => {
    (
      window as typeof window & {
        setIntarTestVisibility: (state: DocumentVisibilityState) => void;
      }
    ).setIntarTestVisibility("hidden");
  });
  await expect.poll(() => closed).toBe(1);
  expect(sockets).toHaveLength(1);

  await page.evaluate(() => {
    (
      window as typeof window & {
        setIntarTestVisibility: (state: DocumentVisibilityState) => void;
      }
    ).setIntarTestVisibility("visible");
  });
  await expect.poll(() => sockets.length).toBe(2);
  const acknowledgedStatus = page.waitForResponse(
    (response) =>
      /\/api\/scenarios\/runs\/run-active\/status(?:\?|$)/.test(response.url()),
  );
  sockets[1]!.send(JSON.stringify({ type: "subscribed", runId: "run-active" }));
  await acknowledgedStatus;

  expect(sockets).toHaveLength(2);
  // The background run keeps a hidden, pending transport mounted. The shell
  // must never be revealed while the gateway has not reported the ready target,
  // so the learner still sees the preparation screen.
  await expect(page.locator('[data-scenario-terminal-ready]')).toHaveCount(0);
  await expect(page.locator(".xterm")).not.toBeVisible();
  expect(pendingTerminals.length).toBeGreaterThan(0);
});

test("a stalled web font does not block the terminal", async ({ page, ui }) => {
  await page.addInitScript(() => {
    document.fonts.load = () => new Promise<FontFace[]>(() => {});
    document.fonts.check = () => false;
  });
  await ui.open({ ...routeCase("run-workspace"), runState: "running" });
  await expect(page.locator(".xterm")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();
});

test("a rejected web font does not block the terminal", async ({ page, ui }) => {
  await page.addInitScript(() => {
    document.fonts.load = () => Promise.reject(new Error("fixture font failure"));
    document.fonts.check = () => false;
  });
  await ui.open({ ...routeCase("run-workspace"), runState: "running" });
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();
});

test("a late web font load refits the connected terminal", async ({ page, ui }) => {
  await page.addInitScript(() => {
    let resolveFont: ((faces: FontFace[]) => void) | null = null;
    Object.assign(window, {
      releaseIntarTerminalFont: () => {
        if (!resolveFont) throw new Error("font load was not started");
        resolveFont([{ status: "loaded" } as FontFace]);
      },
    });
    document.fonts.load = () =>
      new Promise<FontFace[]>((resolve) => {
        resolveFont = resolve;
      });
    document.fonts.check = () => false;
  });
  const terminal = await captureTerminalControls(page);
  await ui.open({ ...routeCase("run-workspace"), runState: "running" });
  await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();

  // Finish the normal xterm resize debounce before the late font resolves.
  await page.clock.pauseAt(FIXED_NOW + 1_000);
  await page.clock.runFor(250);
  const resizeCount = terminal.controls.filter(
    (control) => control.type === "resize",
  ).length;
  expect(resizeCount).toBeGreaterThan(0);

  await page.evaluate(() => {
    const release = (
      window as typeof window & { releaseIntarTerminalFont?: () => void }
    ).releaseIntarTerminalFont;
    if (!release) throw new Error("font release hook is unavailable");
    release();
  });
  await expect
    .poll(
      () =>
        terminal.controls.filter((control) => control.type === "resize").length,
    )
    .toBeGreaterThan(resizeCount);
  await page.clock.resume();
});

test("a late font callback does not resize a closed terminal", async ({ page, ui }) => {
  await page.addInitScript(() => {
    let resolveFont: ((faces: FontFace[]) => void) | null = null;
    Object.assign(window, {
      releaseIntarTerminalFont: () => {
        if (!resolveFont) throw new Error("font load was not started");
        resolveFont([{ status: "loaded" } as FontFace]);
      },
    });
    document.fonts.load = () =>
      new Promise<FontFace[]>((resolve) => {
        resolveFont = resolve;
      });
    document.fonts.check = () => false;
  });
  const terminal = await captureTerminalControls(page);
  await ui.open({ ...routeCase("run-workspace"), runState: "running" });
  await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();

  await page.getByRole("button", { name: "End run…" }).click();
  const dialog = page.getByRole("dialog");
  const destroyResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scenarios/runs/run-active/destroy") &&
      response.status() === 202,
  );
  await dialog.getByRole("button", { name: "End run" }).click();
  await destroyResponse;
  await expect(
    page.getByRole("heading", { name: "Saving your run…" }),
  ).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
  await expect.poll(terminal.isClosed).toBe(true);
  const controlsAfterClose = terminal.controls.length;

  await page.evaluate(async () => {
    const release = (
      window as typeof window & { releaseIntarTerminalFont?: () => void }
    ).releaseIntarTerminalFont;
    if (!release) throw new Error("font release hook is unavailable");
    release();
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
  expect(terminal.controls).toHaveLength(controlsAfterClose);
});

test("a failed status socket keeps the 750 ms startup poll active", async ({
  page,
  ui,
}) => {
  let socketAttempts = 0;
  await page.routeWebSocket(/\/api\/scenarios\/runs\/[^/]+\/status\/stream$/, (ws) => {
    socketAttempts += 1;
    void ws.close({ code: 1011, reason: "fixture status stream failure" });
  });
  await ui.open({ ...routeCase("run-workspace"), runState: "launching" });
  await expect.poll(() => socketAttempts).toBe(1);

  await page.clock.pauseAt(FIXED_NOW + 1_000);
  ui.server.setRunState("running");
  const statusResponse = page.waitForResponse(
    (response) =>
      /\/api\/scenarios\/runs\/run-active\/status(?:\?|$)/.test(response.url()) &&
      response.status() === 200,
  );
  await page.clock.runFor(750);
  await statusResponse;
  await page.clock.resume();

  await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();
  expect(socketAttempts).toBe(1);
});

interface TerminalBinaryFrame {
  bytes: Buffer;
  /** Wall-clock time this mock received the frame. */
  receivedAt: number;
}

interface BenchmarkTerminal {
  binaryFrames: TerminalBinaryFrame[];
  /** True once the page asked the gateway to open the shell. */
  opened: () => boolean;
  /** True while the gateway has not yet reported the ready target. */
  pending: () => boolean;
  /** Answers the handshake. Returns false when it was already answered. */
  sendReady: () => boolean;
}

/**
 * Captures the terminal socket of the run workspace without auto-answering the
 * handshake, so the test decides exactly when the gateway becomes ready.
 */
async function captureBenchmarkTerminal(page: Page): Promise<BenchmarkTerminal> {
  const binaryFrames: TerminalBinaryFrame[] = [];
  let opened = false;
  let readySent = false;
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("ws://terminal.example.test/terminal/**", (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      if (typeof message === "string") {
        try {
          const control = JSON.parse(message) as TerminalControl;
          if (control.type === "open") opened = true;
        } catch {
          // Binary terminal input is not parsed here.
        }
        return;
      }
      // The benchmark command is the only binary frame this client sends
      // before the learner types, so any binary frame is measured here.
      const bytes = Buffer.from(message);
      binaryFrames.push({ bytes, receivedAt: Date.now() });
      const nonce = decodeNonceCommand(bytes);
      if (nonce) {
        // Echo the nonce so the benchmark can complete and report its own
        // timings through the console record.
        ws.send(Buffer.from(`${nonce}\r\n`, "utf8"));
      }
    });
  });
  return {
    binaryFrames,
    opened: () => opened,
    pending: () => !readySent,
    sendReady: () => {
      if (readySent || !socket) return false;
      readySent = true;
      const target = socket;
      target.send(JSON.stringify({ type: "ready" }));
      target.send(
        Buffer.from("\r\nintar scenario shell\r\nroot@web:~# ", "utf8"),
      );
      return true;
    },
  };
}

/**
 * Recovers the nonce from the octal-escaped printf command. The shell echo
 * shows the escapes, so only the decoded form can complete the benchmark.
 */
function decodeNonceCommand(payload: Buffer): string | null {
  const text = new TextDecoder().decode(payload);
  const prefix = "printf '";
  const suffix = "\\n'\r";
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const octal = text.slice(prefix.length, text.length - suffix.length);
  if (!octal || octal.length % 4 !== 0) return null;
  const bytes: number[] = [];
  for (let index = 0; index < octal.length; index += 4) {
    if (octal[index] !== "\\") return null;
    const value = Number.parseInt(octal.slice(index + 1, index + 4), 8);
    if (!Number.isFinite(value)) return null;
    bytes.push(value);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Seeds the opt-in benchmark evidence for the run the workspace route serves.
 * This is the same record the real Start click writes.
 */
async function seedBenchmarkEvidence(page: Page) {
  await page.addInitScript((startUnixMs: number) => {
    try {
      window.sessionStorage.setItem(
        "intar:vm-boot:run-active",
        JSON.stringify({
          runId: "run-active",
          scenarioId: "repair-nginx",
          startUnixMs,
          benchmark: true,
          stages: { "start-click": startUnixMs },
        }),
      );
    } catch {
      // The opaque initial document has no storage; the real origin runs this
      // script again before the application boots.
    }
  }, FIXED_NOW);
}

interface BootBenchmarkRecord {
  runId: string;
  startUnixMs: number;
  terminalConnectedUnixMs: number;
  firstCommand: { startedUnixMs: number; successUnixMs: number };
  stages: Record<string, number>;
}

function captureBootBenchmark(page: Page): BootBenchmarkRecord[] {
  const records: BootBenchmarkRecord[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (!text.startsWith("intar:boot-benchmark ")) return;
    try {
      records.push(JSON.parse(text.slice("intar:boot-benchmark ".length)) as BootBenchmarkRecord);
    } catch {
      // A malformed record is a test failure, not a page failure.
    }
  });
  return records;
}

test("the shell is revealed on the gateway ready frame, not on the status poll", async ({
  page,
  ui,
}) => {
  const benchmarks = captureBootBenchmark(page);
  const terminal = await captureBenchmarkTerminal(page);
  await seedBenchmarkEvidence(page);
  // The projection reports a pending shell for the whole test, so a revealed
  // shell can only come from the gateway handshake.
  await ui.open({ ...routeCase("run-workspace"), runState: "launching" });

  await expect.poll(() => terminal.opened()).toBe(true);
  await expect(page.locator("[data-scenario-terminal-ready]")).toHaveCount(0);
  // The transport now starts during VM boot and holds the socket pending, so a
  // hidden .xterm tree may exist. Only the ready container must stay empty, and
  // nothing may be visible to the learner yet.
  await expect(page.locator("[data-scenario-terminal-ready] .xterm")).toHaveCount(0);
  await expect(page.locator(".xterm")).not.toBeVisible();
  expect(terminal.pending()).toBe(true);
  // Nothing may be measured before the learner can see a terminal.
  expect(terminal.binaryFrames).toHaveLength(0);

  expect(terminal.sendReady()).toBe(true);

  // The ready frame alone reveals the real, on-screen shell while the run
  // projection still reports the pending terminal phase.
  await expect(page.locator("[data-scenario-terminal-ready]")).toBeVisible();
  await expect(page.locator("[data-scenario-terminal-ready] .xterm")).toBeVisible();

  // The benchmark command leaves the client only after that reveal.
  await expect.poll(() => terminal.binaryFrames.length).toBe(1);
  expect(terminal.binaryFrames[0]!.receivedAt).toBeGreaterThanOrEqual(
    await page.evaluate(() => {
      const entry = performance
        .getEntriesByType("mark")
        .find((mark) => mark.name === "intar:vm-boot:terminal-visible");
      return entry ? Math.round(performance.timeOrigin + entry.startTime) : 0;
    }),
  );

  await expect.poll(() => benchmarks.length).toBe(1);
  const record = benchmarks[0]!;
  expect(record.runId).toBe("run-active");
  // The primary interval starts at the click and is never reset by the reveal:
  // only the first command is gated on visibility.
  expect(record.startUnixMs).toBe(FIXED_NOW);
  expect(record.stages["terminal-visible"]).toBeGreaterThanOrEqual(FIXED_NOW);
  expect(record.firstCommand.startedUnixMs).toBeGreaterThanOrEqual(
    record.stages["terminal-visible"]!,
  );
  expect(record.firstCommand.successUnixMs).toBeGreaterThanOrEqual(
    record.firstCommand.startedUnixMs,
  );
});
