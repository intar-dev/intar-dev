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
  await expect(page.locator(".xterm")).toHaveCount(0);
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
