import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserType,
  Page,
  Response,
  WebSocket as PlaywrightWebSocket,
} from "../../apps/web/node_modules/@playwright/test";

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = requireFromWeb("@playwright/test") as {
  chromium: BrowserType;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const VM_BOOT_MARK_PREFIX = "intar:vm-boot:";

export interface BrowserMeasurementOptions {
  origin: string;
  storageState: string;
  startPage: string;
  scenarioId: string;
  variant: "baseline" | "candidate";
  releaseId: string;
  releaseManifestSha256: string;
  participantId: string;
  benchmarkRunId: string;
  output: string;
  onRunAcceptedOutput?: string;
  timeoutMs: number;
}

interface StartAcceptedResponse {
  runId: string;
  acceptedUnixMs: number;
  attempts: number;
}

export function freshStartRunId(responseOk: boolean, body: unknown) {
  const record = asRecord(body);
  return responseOk &&
    record?.accepted === true &&
    record.reused === false &&
    typeof record.runId === "string"
    ? record.runId
    : null;
}

interface StoredBootEvidence {
  runId: string;
  scenarioId: string;
  startUnixMs: number;
  terminalConnectedUnixMs?: number;
  stages: Record<string, number>;
}

type CompleteStoredBootEvidence = StoredBootEvidence & {
  terminalConnectedUnixMs: number;
};

export interface BrowserMeasurementEvidence {
  schemaVersion: 1;
  benchmarkRunId: string;
  participantId: string;
  variant: string;
  releaseId: string;
  releaseManifestSha256: string;
  runId: string;
  scenarioId: string;
  startPage: string;
  startBoundary: "learner-start-link-click";
  startUnixMs: number;
  startAttempts: number;
  terminalConnectedUnixMs: number;
  firstCommand: {
    startedUnixMs: number;
    successUnixMs: number;
    nonceSha256: string;
    outputObservedAfterCommand: true;
  };
  stages: Record<string, number>;
}

const USAGE = `Usage:
  bun tools/vm-boot-benchmark/playwright-runner.ts \\
    --origin <https://intar.example> \\
    --storage-state <playwright-storage-state.json> \\
    --start-page </courses/course-id/lectures/lecture-id> \\
    --scenario-id <scenario> \\
    --variant <baseline|candidate> \\
    --release-id <deployed-release-id> \\
    --release-manifest-sha256 <sha256> \\
    --participant-id <unique-concurrent-participant> \\
    --run-id <benchmark-schedule-id> \\
    --output <evidence.json> [--on-run-accepted-output <accepted.json>] \\
    [--timeout-ms <milliseconds>]

The runner opens --start-page and clicks its visible learner Start scenario
link. The application generates the scenario run ID. --run-id identifies this
benchmark schedule entry and is not sent to the start API.`;

export function parseRunnerArguments(argv: string[]): BrowserMeasurementOptions {
  const values = new Map<string, string>();
  const known = new Set([
    "origin",
    "storage-state",
    "start-page",
    "scenario-id",
    "variant",
    "release-id",
    "release-manifest-sha256",
    "participant-id",
    "run-id",
    "output",
    "on-run-accepted-output",
    "timeout-ms",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const equalsAt = argument.indexOf("=");
    const key = argument.slice(2, equalsAt === -1 ? undefined : equalsAt);
    if (!known.has(key)) throw new Error(`unknown option: --${key}`);
    if (values.has(key)) throw new Error(`option supplied more than once: --${key}`);
    const value =
      equalsAt === -1 ? argv[++index] : argument.slice(equalsAt + 1);
    if (!value || value.startsWith("--")) {
      throw new Error(`option requires a value: --${key}`);
    }
    values.set(key, value);
  }

  const required = (key: string) => {
    const value = values.get(key)?.trim();
    if (!value) throw new Error(`missing required option: --${key}`);
    return value;
  };
  const timeoutText = values.get("timeout-ms") ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeoutText);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }

  const origin = normalizeOrigin(required("origin"));
  const startPage = normalizeStartPage(required("start-page"), origin);
  const releaseManifestSha256 = required("release-manifest-sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(releaseManifestSha256)) {
    throw new Error("--release-manifest-sha256 must be a SHA-256 value");
  }

  const storageState = resolve(required("storage-state"));
  if (!existsSync(storageState)) {
    throw new Error("--storage-state does not exist");
  }

  return {
    origin,
    storageState,
    startPage,
    scenarioId: requireSafeIdentifier("scenario-id", required("scenario-id")),
    variant: requireVariant(required("variant")),
    releaseId: requireSafeIdentifier("release-id", required("release-id")),
    releaseManifestSha256,
    participantId: requireSafeIdentifier("participant-id", required("participant-id")),
    benchmarkRunId: requireSafeIdentifier("run-id", required("run-id")),
    output: resolve(required("output")),
    ...(values.has("on-run-accepted-output")
      ? { onRunAcceptedOutput: resolve(required("on-run-accepted-output")) }
      : {}),
    timeoutMs,
  };
}

function normalizeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--origin must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("--origin must be a plain HTTP(S) origin");
  }
  return url.origin;
}

export function normalizeStartPage(value: string, origin: string) {
  if (!value.startsWith("/") && !/^https?:\/\//iu.test(value)) {
    throw new Error("--start-page must be a same-origin path or URL");
  }
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new Error("--start-page must be a same-origin path or URL");
  }
  if (
    url.origin !== origin ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("--start-page must be a same-origin path or URL");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function requireSafeIdentifier(name: string, value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value)) {
    throw new Error(`--${name} contains unsupported characters`);
  }
  return value;
}

function requireVariant(value: string): "baseline" | "candidate" {
  if (value !== "baseline" && value !== "candidate") {
    throw new Error("--variant must be baseline or candidate");
  }
  return value;
}

export function nonEchoNonceCommand(nonce: string) {
  const octal = Buffer.from(nonce, "utf8")
    .toString("hex")
    .match(/../gu)
    ?.map(
      (byte) =>
        `\\${Number.parseInt(byte, 16).toString(8).padStart(3, "0")}`,
    )
    .join("");
  if (!octal || octal.includes(nonce)) {
    throw new Error("could not encode nonce command");
  }
  // The shell echo contains octal escapes; only printf writes the nonce.
  return `printf '${octal}\\n'`;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseStoredBootEvidence(
  value: unknown,
  runId: string,
  scenarioId: string,
): StoredBootEvidence | null {
  const record = asRecord(value);
  if (!record || record.runId !== runId || record.scenarioId !== scenarioId) {
    return null;
  }
  const startUnixMs = finiteNumber(record.startUnixMs);
  const stagesRecord = asRecord(record.stages);
  if (startUnixMs === null || !stagesRecord) return null;

  const stages: Record<string, number> = {};
  for (const [stage, unixMs] of Object.entries(stagesRecord)) {
    const timestamp = finiteNumber(unixMs);
    if (/^[a-z0-9-]{1,80}$/u.test(stage) && timestamp !== null) {
      stages[stage] = timestamp;
    }
  }
  return {
    runId,
    scenarioId,
    startUnixMs,
    ...(finiteNumber(record.terminalConnectedUnixMs) === null
      ? {}
      : { terminalConnectedUnixMs: finiteNumber(record.terminalConnectedUnixMs)! }),
    stages,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function remainingTimeout(deadlineUnixMs: number) {
  const remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0) throw new Error("benchmark timed out");
  return remaining;
}

export function learnerStartRoutePath(scenarioId: string) {
  return `/runs/start/${encodeURIComponent(scenarioId)}`;
}

function runPath(origin: string, runId: string) {
  return `${origin}/runs/${encodeURIComponent(runId)}`;
}

function observeScenarioStart(
  page: Page,
  origin: string,
  scenarioId: string,
  deadlineUnixMs: number,
) {
  const targetPath = `/api/scenarios/${encodeURIComponent(scenarioId)}/start`;
  let attempts = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancel: () => void = () => {};

  const promise = new Promise<StartAcceptedResponse>((resolveStart, rejectStart) => {
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      page.off("response", onResponse);
      if (timer !== null) clearTimeout(timer);
      callback();
    };
    const onResponse = async (response: Response) => {
      const request = response.request();
      const responseUrl = new URL(response.url());
      if (
        request.method() !== "POST" ||
        responseUrl.origin !== origin ||
        responseUrl.pathname !== targetPath
      ) {
        return;
      }
      attempts += 1;
      const body = (await response.json().catch(() => null)) as unknown;
      const record = asRecord(body);
      const acceptedRunId = freshStartRunId(response.ok(), body);
      if (acceptedRunId) {
        finish(() =>
          resolveStart({
            runId: acceptedRunId,
            acceptedUnixMs: Date.now(),
            attempts,
          }),
        );
        return;
      }
      const code = typeof record?.code === "string" ? record.code : null;
      if (
        response.status() === 409 &&
        (code === "boot_capacity_pending" || code === "runtime_allocation_busy")
      ) {
        return;
      }
      if (record?.accepted === true && typeof record.runId === "string") {
        finish(() =>
          rejectStart(new Error("start API did not prove a fresh run")),
        );
        return;
      }
      finish(() =>
        rejectStart(new Error(`scenario start request failed (HTTP ${response.status()})`)),
      );
    };
    page.on("response", onResponse);
    cancel = () => finish(() => rejectStart(new Error("scenario start was cancelled")));
    timer = setTimeout(
      () =>
        finish(() =>
          rejectStart(
            new Error("scenario start did not complete before the timeout"),
          ),
        ),
      remainingTimeout(deadlineUnixMs),
    );
  });

  return { promise, cancel };
}

async function waitForConnectedTerminal(page: Page, deadlineUnixMs: number) {
  await page
    .locator("[data-scenario-terminal-ready]")
    .waitFor({ state: "visible", timeout: remainingTimeout(deadlineUnixMs) });
  await page
    .locator('[data-terminal-status="connected"]')
    .waitFor({ state: "visible", timeout: remainingTimeout(deadlineUnixMs) });
  await page
    .locator(".xterm")
    .first()
    .waitFor({ state: "visible", timeout: remainingTimeout(deadlineUnixMs) });
}

export function scanRemoteTerminalFrame(input: {
  needle: string;
  previousTail: string;
  payload: string | Uint8Array;
}) {
  const frame =
    typeof input.payload === "string"
      ? input.payload
      : new TextDecoder().decode(input.payload);
  const combined = `${input.previousTail}${frame}`;
  const tailLength = Math.max(0, input.needle.length - 1);
  return {
    matches: combined.includes(input.needle),
    nextTail: tailLength === 0 ? "" : combined.slice(-tailLength),
  };
}

interface RemoteTerminalFrameObserver {
  expectRun(runId: string): void;
  waitForSocketListeners(timeoutMs: number): Promise<void>;
  arm(nonce: string, outboundCommand: string): void;
  waitForNonce(timeoutMs: number): Promise<number>;
  dispose(): void;
}

interface FrameWaiter {
  resolve: (unixMs: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function sameWebSocketUrl(left: string, right: string) {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

export function observeRemoteTerminalFrames(
  page: Page,
  origin: string,
): RemoteTerminalFrameObserver {
  let expectedSessionPath: string | null = null;
  let expectedWebSocketUrl: string | null = null;
  let cachedSession: { path: string; websocketUrl: string } | null = null;
  let nonce: string | null = null;
  let outboundCommand: string | null = null;
  let outboundTail = "";
  let inboundTail = "";
  let commandSentUnixMs: number | null = null;
  let nonceObservedUnixMs: number | null = null;
  let disposed = false;
  const sockets = new Set<PlaywrightWebSocket>();
  const attachedSockets = new Set<PlaywrightWebSocket>();
  let nonceWaiter: FrameWaiter | null = null;
  let socketListenersAttached = false;
  let resolveSocketListenersAttached: (() => void) | null = null;
  const socketListenersAttachedPromise = new Promise<void>((resolveReady) => {
    resolveSocketListenersAttached = resolveReady;
  });

  const onFrameReceived = (frame: { payload: string | Buffer }) => {
    if (!nonce || commandSentUnixMs === null || nonceObservedUnixMs !== null) {
      return;
    }
    const scanned = scanRemoteTerminalFrame({
      needle: nonce,
      previousTail: inboundTail,
      payload: frame.payload,
    });
    inboundTail = scanned.nextTail;
    if (scanned.matches) {
      nonceObservedUnixMs = Date.now();
      if (nonceWaiter) {
        clearTimeout(nonceWaiter.timer);
        nonceWaiter.resolve(nonceObservedUnixMs);
        nonceWaiter = null;
      }
    }
  };

  const onFrameSent = (frame: { payload: string | Buffer }) => {
    if (!outboundCommand || commandSentUnixMs !== null) return;
    const scanned = scanRemoteTerminalFrame({
      needle: outboundCommand,
      previousTail: outboundTail,
      payload: frame.payload,
    });
    outboundTail = scanned.nextTail;
    if (scanned.matches) {
      commandSentUnixMs = Date.now();
    }
  };

  const attachSocket = (socket: PlaywrightWebSocket) => {
    if (attachedSockets.has(socket)) return;
    attachedSockets.add(socket);
    socket.on("framereceived", onFrameReceived);
    socket.on("framesent", onFrameSent);
    if (!socketListenersAttached) {
      socketListenersAttached = true;
      resolveSocketListenersAttached?.();
      resolveSocketListenersAttached = null;
    }
  };

  const attachExpectedSockets = () => {
    if (!expectedWebSocketUrl) return;
    for (const socket of sockets) {
      if (sameWebSocketUrl(socket.url(), expectedWebSocketUrl)) {
        attachSocket(socket);
      }
    }
  };

  const onWebSocket = (socket: PlaywrightWebSocket) => {
    if (disposed) return;
    sockets.add(socket);
    attachExpectedSockets();
  };

  const acceptSession = (path: string, websocketUrl: string) => {
    if (expectedSessionPath === null) {
      cachedSession = { path, websocketUrl };
      return;
    }
    if (path !== expectedSessionPath) return;
    expectedWebSocketUrl = websocketUrl;
    cachedSession = null;
    attachExpectedSockets();
  };

  const onResponse = async (response: Response) => {
    if (disposed) return;
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url());
    } catch {
      return;
    }
    if (
      response.request().method() !== "POST" ||
      responseUrl.origin !== origin ||
      !/^\/api\/scenarios\/runs\/[^/]+\/ssh$/u.test(responseUrl.pathname) ||
      !response.ok()
    ) {
      return;
    }
    const body = asRecord(await response.json().catch(() => null));
    const websocketUrl = body && asRecord(body.browser)?.websocketUrl;
    if (disposed || typeof websocketUrl !== "string") return;
    acceptSession(responseUrl.pathname, websocketUrl);
  };

  page.on("websocket", onWebSocket);
  page.on("response", onResponse);

  return {
    expectRun(runId) {
      if (expectedSessionPath !== null) {
        throw new Error("terminal frame observer already has a run");
      }
      expectedSessionPath = `/api/scenarios/runs/${encodeURIComponent(runId)}/ssh`;
      if (cachedSession?.path === expectedSessionPath) {
        acceptSession(cachedSession.path, cachedSession.websocketUrl);
      }
    },
    waitForSocketListeners(timeoutMs) {
      if (socketListenersAttached) return Promise.resolve();
      if (disposed) {
        return Promise.reject(new Error("terminal frame observation stopped"));
      }
      return new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          rejectReady(new Error("terminal WebSocket listeners were not attached"));
        }, timeoutMs);
        void socketListenersAttachedPromise.then(() => {
          clearTimeout(timer);
          resolveReady();
        });
      });
    },
    arm(expectedNonce, expectedOutboundCommand) {
      if (nonce !== null || outboundCommand !== null) {
        throw new Error("terminal frame observer is already armed");
      }
      nonce = expectedNonce;
      outboundCommand = expectedOutboundCommand;
    },
    waitForNonce(timeoutMs) {
      if (nonceObservedUnixMs !== null) return Promise.resolve(nonceObservedUnixMs);
      if (disposed) return Promise.reject(new Error("terminal frame observation stopped"));
      if (nonceWaiter) {
        return Promise.reject(new Error("terminal nonce wait is already pending"));
      }
      return new Promise<number>((resolveWait, rejectWait) => {
        const waiter: FrameWaiter = {
          resolve: resolveWait,
          reject: rejectWait,
          timer: setTimeout(() => {
            if (nonceWaiter === waiter) nonceWaiter = null;
            rejectWait(
              new Error(
                "terminal command was not sent or its WebSocket did not return the benchmark nonce",
              ),
            );
          }, timeoutMs),
        };
        nonceWaiter = waiter;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      page.off("websocket", onWebSocket);
      page.off("response", onResponse);
      for (const socket of attachedSockets) {
        socket.off("framereceived", onFrameReceived);
        socket.off("framesent", onFrameSent);
      }
      if (nonceWaiter) {
        clearTimeout(nonceWaiter.timer);
        nonceWaiter.reject(new Error("terminal frame observation stopped"));
        nonceWaiter = null;
      }
    },
  };
}

async function clickLearnerStartLink(input: {
  page: Page;
  origin: string;
  scenarioId: string;
  deadlineUnixMs: number;
}) {
  const targetPath = learnerStartRoutePath(input.scenarioId);
  await input.page.waitForFunction(
    (path: string) =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).some(
        (link) => {
          const url = new URL(link.href, window.location.origin);
          const rect = link.getBoundingClientRect();
          return url.pathname === path && rect.width > 0 && rect.height > 0;
        },
      ),
    targetPath,
    { timeout: remainingTimeout(input.deadlineUnixMs) },
  );

  const links = input.page.locator("a[href]");
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");
    if (!href || new URL(href, input.origin).pathname !== targetPath) continue;
    if (!(await link.isVisible())) continue;
    const clickedUnixMs = Date.now();
    await link.click({ timeout: remainingTimeout(input.deadlineUnixMs) });
    return clickedUnixMs;
  }
  throw new Error("learner start link disappeared before it could be clicked");
}

async function verifyTerminalCommand(
  page: Page,
  deadlineUnixMs: number,
  frames: RemoteTerminalFrameObserver,
) {
  const nonce = `intar-bench-${randomUUID().replaceAll("-", "")}`;
  const command = nonEchoNonceCommand(nonce);
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
  await terminalInput.click({ timeout: remainingTimeout(deadlineUnixMs) });
  const startedUnixMs = Date.now();
  frames.arm(nonce, `${command}\r`);
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  const successUnixMs = await frames.waitForNonce(remainingTimeout(deadlineUnixMs));
  return {
    startedUnixMs,
    successUnixMs,
    nonceSha256: sha256(nonce),
    outputObservedAfterCommand: true as const,
  };
}

async function readBrowserBootEvidence(page: Page, runId: string, scenarioId: string) {
  const stored = await page.evaluate(
    ({ runId: expectedRunId, prefix }: { runId: string; prefix: string }) =>
      window.sessionStorage.getItem(`${prefix}${expectedRunId}`),
    { runId, prefix: VM_BOOT_MARK_PREFIX },
  );

  let storedValue: unknown = null;
  try {
    storedValue = stored ? JSON.parse(stored) : null;
  } catch {
    // A malformed browser record cannot enter benchmark evidence.
  }
  return parseStoredBootEvidence(storedValue, runId, scenarioId);
}

function requireCompleteBrowserEvidence(
  evidence: StoredBootEvidence | null,
): CompleteStoredBootEvidence {
  if (
    !evidence ||
    evidence.stages["start-click"] === undefined ||
    evidence.stages["terminal-connected"] === undefined ||
    evidence.terminalConnectedUnixMs === undefined
  ) {
    throw new Error(
      "browser boot evidence is missing start-click or terminal-connected",
    );
  }
  return evidence as CompleteStoredBootEvidence;
}

export async function runBrowserMeasurement(
  options: BrowserMeasurementOptions,
): Promise<BrowserMeasurementEvidence> {
  const deadlineUnixMs = Date.now() + options.timeoutMs;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: options.storageState,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  const terminalFrames = observeRemoteTerminalFrames(page, options.origin);

  try {
    const start = observeScenarioStart(
      page,
      options.origin,
      options.scenarioId,
      deadlineUnixMs,
    );
    let accepted: StartAcceptedResponse;
    let learnerStartLinkClickedUnixMs: number;
    try {
      await page.goto(new URL(options.startPage, options.origin).href, {
        waitUntil: "domcontentloaded",
        timeout: remainingTimeout(deadlineUnixMs),
      });
      learnerStartLinkClickedUnixMs = await clickLearnerStartLink({
        page,
        origin: options.origin,
        scenarioId: options.scenarioId,
        deadlineUnixMs,
      });
      accepted = await start.promise;
    } catch (error) {
      start.cancel();
      throw error;
    }
    if (options.onRunAcceptedOutput) {
      writeAcceptedRun(
        options.onRunAcceptedOutput,
        accepted,
        options.scenarioId,
      );
    }
    terminalFrames.expectRun(accepted.runId);
    await page.waitForURL(runPath(options.origin, accepted.runId), {
      timeout: remainingTimeout(deadlineUnixMs),
    });
    await waitForConnectedTerminal(page, deadlineUnixMs);
    await terminalFrames.waitForSocketListeners(
      remainingTimeout(deadlineUnixMs),
    );
    const firstCommand = await verifyTerminalCommand(
      page,
      deadlineUnixMs,
      terminalFrames,
    );
    const sessionEvidence = requireCompleteBrowserEvidence(
      await readBrowserBootEvidence(page, accepted.runId, options.scenarioId),
    );

    return {
      schemaVersion: 1,
      benchmarkRunId: options.benchmarkRunId,
      participantId: options.participantId,
      variant: options.variant,
      releaseId: options.releaseId,
      releaseManifestSha256: options.releaseManifestSha256,
      runId: accepted.runId,
      scenarioId: options.scenarioId,
      startPage: options.startPage,
      startBoundary: "learner-start-link-click",
      startUnixMs: sessionEvidence.startUnixMs,
      startAttempts: accepted.attempts,
      terminalConnectedUnixMs: sessionEvidence.terminalConnectedUnixMs,
      firstCommand,
      stages: {
        ...sessionEvidence.stages,
        "learner-start-link-click": learnerStartLinkClickedUnixMs,
        "start-accepted": accepted.acceptedUnixMs,
      },
    };
  } finally {
    terminalFrames.dispose();
    await context.close();
    await browser.close();
  }
}

function writeEvidence(path: string, evidence: BrowserMeasurementEvidence) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}

function writeAcceptedRun(
  path: string,
  accepted: StartAcceptedResponse,
  scenarioId: string,
) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({
        runId: accepted.runId,
        scenarioId,
        reused: false,
        acceptedUnixMs: accepted.acceptedUnixMs,
      })}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    throw new Error("could not write accepted-run evidence");
  }
}

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parseRunnerArguments(argv);
  const evidence = await runBrowserMeasurement(options);
  writeEvidence(options.output, evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "benchmark failed";
    process.stderr.write(`playwright benchmark failed: ${message}\n`);
    process.exitCode = 1;
  });
}
