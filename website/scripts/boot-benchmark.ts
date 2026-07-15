import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import type { ScenarioRunRecord } from "../src/lib/scenario-runs";
import {
  BOOT_BENCHMARK_VARIANTS,
  BOOT_BENCHMARK_MEASUREMENT_BOUNDARY,
  BOOT_BENCHMARK_SCHEMA_VERSION,
  BOOT_BENCHMARK_CPU_POLICIES,
  PROMOTION_SAMPLE_COUNT,
  PROMOTION_WARMUP_COUNT,
  bootArtifactFingerprint,
  bootArtifactIdentity,
  evaluatePromotionGate,
  hasExactBootCpuSamples,
  hasExactSteadyResourceState,
  sealProjectionReadyDurationMs,
  sealProjectionUiReadyDurationMs,
  summarizeBootSamples,
  type BootBenchmarkResultV1,
  type BootBenchmarkVariant,
  type BootSampleV1,
  type PassedBootSampleV1,
} from "./boot-benchmark-core";
import {
  ApiClient,
  parseManifest,
  type ApiClientAuth,
  type ApiClientRequestPolicy,
} from "./live-e2e";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = String(
  (require("@playwright/test/package.json") as { version: unknown }).version,
);

const REQUIRED_FAST_CAPABILITIES = [
  "supports_kvm",
  "supports_vsock",
  "supports_reflink",
  "supports_nftables",
  "supports_jailer_v2",
  "supports_hard_cpu_quota",
  "supports_boot_cpu_lease",
  "supports_template_backed_launch",
  "fast_template_store",
  "supports_landlock",
  "supports_cgroup_v2",
] as const;

export interface BootBenchmarkOptions {
  baseUrl: string;
  auth: ApiClientAuth;
  browserSession: BootBenchmarkBrowserSessionIdentity | null;
  hostId: string;
  variant: BootBenchmarkVariant;
  manifestPath: string;
  outputPath: string;
  implementationSha256: string;
  cloudHypervisorSha256: string | null;
  coldPrewarmStartedAtUnixMs: number | null;
  warmups: number;
  measuredSamples: number;
  pollMs: number;
  waitReadyMs: number;
  waitIdleMs: number;
  terminalProbeTimeoutMs: number;
}

interface HostResponse {
  host: {
    id: string;
    role: string;
    disabled: boolean;
    scenarioEnabled: boolean;
    status: {
      connected: boolean;
      agentVersion: string | null;
    };
    actualState: {
      appliedDesiredVersion: number;
      observedAt: number;
      health: "healthy" | "degraded" | "unknown";
      capacity: {
        committed_cpu_millis: number;
      };
      capabilities: Record<string, unknown> & { arch?: unknown };
      cachedImages: Array<{
        image_key: {
          scenario: string;
          vm: string;
          arch: string;
        };
        image_sha256: string;
        phase: string;
        error?: string | null;
        updated_at_unix_ms: number;
      }>;
      builds: Array<{ build_id: string; phase: string }>;
      vms: Array<{
        run_id: string;
        vm_name: string;
        phase: string;
      }>;
    } | null;
    desiredState: {
      version: number;
      cachedImages: Array<{
        image_key: { scenario: string; vm: string; arch: string };
        image_sha256: string;
      }>;
      vms: Array<{
        run_id: string;
        vm_name: string;
        desired_phase: string;
      }>;
      builds: Array<{ build_id: string }>;
    } | null;
    benchmarkLease: {
      runId: string;
      acquiredAt: number;
      updatedAt: number;
    } | null;
  };
}

type HostActualVm = NonNullable<
  HostResponse["host"]["actualState"]
>["vms"][number];

interface StartRunResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}

interface RunResponse {
  run: ScenarioRunRecord;
}

interface HostEvidence {
  agentVersion: string | null;
  observedAt: number;
  capabilities: Record<string, boolean | string | number | null>;
  cloudHypervisorSha256: string;
  performanceReady: boolean;
  cachedImages: BootBenchmarkResultV1["prewarm"]["cached_images"];
  capabilitiesFingerprint: string;
  desiredCachedImagesFingerprint: string;
  actualCachedImagesFingerprint: string;
}

interface IsolationMonitor {
  failure: Promise<never>;
  beginTeardown: () => void;
  attest: (host: HostResponse["host"]) => void;
  evidence: () => NonNullable<PassedBootSampleV1["isolation_evidence"]>;
  failureReason: () => FatalIsolationError | null;
  stop: () => void;
}

class FatalIsolationError extends Error {}

class AcceptedRunContractError extends Error {
  readonly clock: MeasurementClock;
  readonly runId: string;
  readonly reused: boolean;

  constructor(input: {
    message: string;
    clock: MeasurementClock;
    runId: string;
    reused: boolean;
  }) {
    super(input.message);
    this.clock = input.clock;
    this.runId = input.runId;
    this.reused = input.reused;
  }
}

interface MeasurementClock {
  startedAt: number;
  startedAtUnixMs: number;
}

interface BrowserTerminalObservation {
  uiTerminalReadyMs: number;
  uiTerminalReadyAtUnixMs: number;
  terminalWebsocketReadyMs: number;
  terminalWebsocketReadyAtUnixMs: number;
  usableTerminalMs: number;
}

interface BrowserStartObservation {
  clock: MeasurementClock;
  start: StartRunResponse;
  acceptedMs: number;
  terminal: Promise<BrowserTerminalObservation>;
}

export interface BrowserCookie {
  name: string;
  value: string;
  url: string;
}

const SET_COOKIE_ATTRIBUTE_NAMES = new Set([
  "domain",
  "expires",
  "httponly",
  "max-age",
  "partitioned",
  "path",
  "samesite",
  "secure",
]);
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const BOOT_BENCHMARK_BROWSER_CONTEXT_OPTIONS = {
  viewport: { width: 1_440, height: 900 },
  serviceWorkers: "block" as const,
};

export function parseBrowserCookies(
  cookieHeader: string,
  baseUrl: string,
): BrowserCookie[] {
  let origin: string;
  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`unsupported protocol ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("credentials are not allowed in the base URL");
    }
    origin = parsed.origin;
  } catch (error) {
    throw new Error(
      `invalid browser benchmark base URL: ${errorMessage(error)}`,
    );
  }

  if (!cookieHeader.trim()) {
    throw new Error("browser benchmark cookie header must not be empty");
  }
  const seen = new Set<string>();
  return cookieHeader.split(";").map((rawPair) => {
    const pair = rawPair.trim();
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw new Error(`invalid Cookie pair: ${pair || "<empty>"}`);
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    if (!COOKIE_NAME_PATTERN.test(name)) {
      throw new Error(`invalid Cookie name: ${name || "<empty>"}`);
    }
    if (SET_COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
      throw new Error(
        `Cookie header contains Set-Cookie attribute ${name}; provide only cookie name/value pairs`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`duplicate Cookie name: ${name}`);
    }
    if (/[\u0000-\u001f\u007f;]/.test(value)) {
      throw new Error(`invalid control character in Cookie value for ${name}`);
    }
    seen.add(name);
    return { name, value, url: origin };
  });
}

const BOOT_BENCHMARK_SESSION_PATH = "/api/auth/get-session";
const BOOT_BENCHMARK_RUNS_PATH = "/api/scenarios/runs";
const BOOT_BENCHMARK_MAX_AUTH_TTL_MS = 3 * 60 * 60 * 1_000;
const BOOT_BENCHMARK_MIN_TOKEN_BYTES = 32;

export interface BootBenchmarkBrowserSessionIdentity {
  userId: string;
  expiresAtUnixMs: number;
}

export type BootBenchmarkApiRequestClass =
  | "network"
  | "local_session"
  | "local_empty_runs"
  | "denied";

export class BootBenchmarkApiPolicy implements ApiClientRequestPolicy {
  private readonly origin: string;
  private readonly hostPath: string;
  private readonly scenarioPath: string;
  private readonly startPath: string;
  private readonly ownedRunIds = new Set<string>();

  constructor(input: { origin: string; hostId: string; scenarioId: string }) {
    this.origin = new URL(input.origin).origin;
    this.hostPath = `/api/agent/hosts/${encodeURIComponent(input.hostId)}`;
    this.scenarioPath = `/api/scenarios/${encodeURIComponent(input.scenarioId)}`;
    this.startPath = `${this.scenarioPath}/start`;
  }

  claimOwnedRun(runId: string): void {
    if (!runId.trim()) {
      throw new Error("cannot claim an empty benchmark run id");
    }
    this.ownedRunIds.add(runId);
  }

  classify(method: string, url: URL): BootBenchmarkApiRequestClass {
    const normalizedMethod = method.toUpperCase();
    if (
      url.origin !== this.origin ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return "denied";
    }
    if (
      normalizedMethod === "GET" &&
      url.pathname === BOOT_BENCHMARK_SESSION_PATH
    ) {
      return "local_session";
    }
    if (
      normalizedMethod === "GET" &&
      url.pathname === BOOT_BENCHMARK_RUNS_PATH
    ) {
      return "local_empty_runs";
    }
    if (
      (normalizedMethod === "GET" &&
        (url.pathname === this.hostPath ||
          url.pathname === this.scenarioPath)) ||
      (normalizedMethod === "POST" && url.pathname === this.startPath)
    ) {
      return "network";
    }

    for (const runId of this.ownedRunIds) {
      const runPath = `${BOOT_BENCHMARK_RUNS_PATH}/${encodeURIComponent(runId)}`;
      if (
        (normalizedMethod === "GET" && url.pathname === runPath) ||
        (normalizedMethod === "POST" &&
          (url.pathname === `${runPath}/ssh` ||
            url.pathname === `${runPath}/destroy`))
      ) {
        return "network";
      }
    }
    return "denied";
  }

  allows(method: string, url: URL): boolean {
    return this.classify(method, url) === "network";
  }
}

interface BrowserBenchmarkContextTarget {
  addCookies(cookies: BrowserCookie[]): Promise<void>;
  route(
    url: string,
    handler: (route: Route) => Promise<void>,
  ): Promise<unknown>;
}

export function isSameOriginApiRequest(
  requestUrl: string,
  origin: string,
): boolean {
  try {
    const request = new URL(requestUrl);
    return (
      request.origin === new URL(origin).origin &&
      (request.pathname === "/api" || request.pathname.startsWith("/api/"))
    );
  } catch {
    return false;
  }
}

export function browserBenchmarkRequestHeaders(input: {
  headers: Record<string, string>;
  requestUrl: string;
  method: string;
  auth: ApiClientAuth;
  policy: BootBenchmarkApiPolicy;
}): Record<string, string> {
  const headers = { ...input.headers };
  if (
    input.auth.kind === "boot_benchmark" &&
    input.policy.allows(input.method, new URL(input.requestUrl))
  ) {
    if (Object.keys(headers).some((name) => name.toLowerCase() === "cookie")) {
      throw new Error(
        "BootBenchmark browser API requests must not include Cookie",
      );
    }
    headers.authorization = `BootBenchmark ${input.auth.token}`;
  }
  return headers;
}

export function bootBenchmarkBrowserSession(
  identity: BootBenchmarkBrowserSessionIdentity,
): Record<string, unknown> {
  const createdAt = new Date(
    Math.max(0, identity.expiresAtUnixMs - BOOT_BENCHMARK_MAX_AUTH_TTL_MS),
  ).toISOString();
  return {
    session: {
      id: "boot-benchmark-browser-session",
      userId: identity.userId,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(identity.expiresAtUnixMs).toISOString(),
    },
    user: {
      id: identity.userId,
      name: "Boot Benchmark",
      email: "boot-benchmark@invalid.example",
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
      role: "user",
    },
  };
}

export async function configureBrowserBenchmarkContext(
  context: BrowserBenchmarkContextTarget,
  input: {
    baseUrl: string;
    auth: ApiClientAuth;
    policy: BootBenchmarkApiPolicy;
    browserSession: BootBenchmarkBrowserSessionIdentity | null;
  },
): Promise<void> {
  const origin = new URL(input.baseUrl).origin;
  if (input.auth.kind === "cookie") {
    await context.addCookies(
      parseBrowserCookies(input.auth.cookie, input.baseUrl),
    );
    return;
  }
  if (!input.browserSession) {
    throw new Error("BootBenchmark browser auth requires a session identity");
  }
  const browserSession = input.browserSession;

  await context.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const requestUrl = request.url();
    const requestHeaders = await request.allHeaders();
    if (
      Object.keys(requestHeaders).some(
        (name) => name.toLowerCase() === "cookie",
      )
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    const url = new URL(requestUrl);
    const requestClass = input.policy.classify(request.method(), url);
    if (requestClass === "local_session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(bootBenchmarkBrowserSession(browserSession)),
      });
      return;
    }
    if (requestClass === "local_empty_runs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }
    if (requestClass !== "network") {
      await route.abort("blockedbyclient");
      return;
    }

    const response = await route.fetch({
      headers: browserBenchmarkRequestHeaders({
        headers: requestHeaders,
        requestUrl,
        method: request.method(),
        auth: input.auth,
        policy: input.policy,
      }),
      maxRedirects: 0,
    });
    if (response.status() >= 300 && response.status() < 400) {
      await route.abort("blockedbyresponse");
      return;
    }
    await route.fulfill({ response });
  });
}

export function browserMarkerCommand(marker: string): string {
  if (!/^[A-Z0-9_]{2,}$/.test(marker)) {
    throw new Error(
      "browser terminal marker must contain at least two A-Z, 0-9, or underscore characters",
    );
  }
  const splitAt = Math.ceil(marker.length / 2);
  const first = marker.slice(0, splitAt);
  const second = marker.slice(splitAt);
  const command = `printf '\\n%s%s\\n' '${first}' '${second}'`;
  if (command.includes(marker)) {
    throw new Error("browser terminal marker was not safely split");
  }
  return command;
}

class BrowserBenchmarkDriver {
  readonly chromiumVersion: string;
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly origin: string;
  private readonly auth: ApiClientAuth;
  private readonly apiPolicy: BootBenchmarkApiPolicy;
  private readonly hostId: string;
  private readonly scenarioId: string;

  private constructor(input: {
    browser: Browser;
    context: BrowserContext;
    page: Page;
    origin: string;
    auth: ApiClientAuth;
    apiPolicy: BootBenchmarkApiPolicy;
    hostId: string;
    scenarioId: string;
  }) {
    this.browser = input.browser;
    this.context = input.context;
    this.page = input.page;
    this.origin = input.origin;
    this.auth = input.auth;
    this.apiPolicy = input.apiPolicy;
    this.hostId = input.hostId;
    this.scenarioId = input.scenarioId;
    this.chromiumVersion = input.browser.version();
  }

  static async create(input: {
    baseUrl: string;
    auth: ApiClientAuth;
    apiPolicy: BootBenchmarkApiPolicy;
    browserSession: BootBenchmarkBrowserSessionIdentity | null;
    hostId: string;
    scenarioId: string;
  }): Promise<BrowserBenchmarkDriver> {
    const origin = new URL(input.baseUrl).origin;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext(
        BOOT_BENCHMARK_BROWSER_CONTEXT_OPTIONS,
      );
      try {
        await configureBrowserBenchmarkContext(context, {
          baseUrl: input.baseUrl,
          auth: input.auth,
          policy: input.apiPolicy,
          browserSession: input.browserSession,
        });
        const page = await context.newPage();
        return new BrowserBenchmarkDriver({
          browser,
          context,
          page,
          origin,
          auth: input.auth,
          apiPolicy: input.apiPolicy,
          hostId: input.hostId,
          scenarioId: input.scenarioId,
        });
      } catch (error) {
        await context.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  async prepareScenario(timeoutMs: number): Promise<void> {
    const scenarioUrl = `${this.origin}/scenarios/${encodeURIComponent(this.scenarioId)}`;
    await this.page.goto(scenarioUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    const button = this.startButton();
    await button.waitFor({ state: "visible", timeout: timeoutMs });
    const deadline = performance.now() + timeoutMs;
    while (!(await button.isEnabled())) {
      if (performance.now() > deadline) {
        throw new Error("timed out waiting for Start scenario to be enabled");
      }
      await sleep(25);
    }
    await button.click({ trial: true, timeout: timeoutMs });
  }

  async clickStart(input: {
    marker: string;
    waitReadyMs: number;
    terminalProbeTimeoutMs: number;
  }): Promise<BrowserStartObservation> {
    const endpoint = `${this.origin}/api/scenarios/${encodeURIComponent(this.scenarioId)}/start`;
    let routeHits = 0;
    let routeFailure: Error | null = null;
    const routeHandler = async (route: Route) => {
      try {
        const request = route.request();
        const requestUrl = new URL(request.url());
        if (
          requestUrl.origin !== this.origin ||
          requestUrl.pathname !==
            `/api/scenarios/${encodeURIComponent(this.scenarioId)}/start` ||
          requestUrl.search ||
          request.method() !== "POST"
        ) {
          throw new Error(
            `refused unexpected routed start request ${request.method()} ${request.url()}`,
          );
        }
        if (request.postData() !== null && request.postData()!.length > 0) {
          throw new Error(
            "refused scenario start request with an unexpected browser body",
          );
        }
        routeHits += 1;
        if (routeHits !== 1) {
          throw new Error(
            "browser issued more than one scenario start request",
          );
        }
        const headers = browserBenchmarkRequestHeaders({
          headers: await request.allHeaders(),
          requestUrl: request.url(),
          method: request.method(),
          auth: this.auth,
          policy: this.apiPolicy,
        });
        delete headers["content-length"];
        headers["content-type"] = "application/json";
        const response = await route.fetch({
          headers,
          maxRedirects: 0,
          postData: JSON.stringify({
            hostId: this.hostId,
            admissionMode: "benchmark",
          }),
        });
        if (response.status() >= 300 && response.status() < 400) {
          throw new Error(
            `refused redirected benchmark start response HTTP ${response.status()}`,
          );
        }
        if (response.ok()) {
          let value: unknown = null;
          try {
            value = JSON.parse(await response.text()) as unknown;
          } catch {
            // The browser response contract check will report malformed JSON.
          }
          if (
            isRecord(value) &&
            value.accepted === true &&
            typeof value.runId === "string" &&
            value.runId.trim()
          ) {
            this.apiPolicy.claimOwnedRun(value.runId);
          }
        }
        await route.fulfill({ response });
      } catch (error) {
        routeFailure =
          error instanceof Error ? error : new Error(errorMessage(error));
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    };

    await this.page.route(endpoint, routeHandler);
    try {
      const responsePromise = this.page.waitForResponse(
        (response) =>
          response.url() === endpoint && response.request().method() === "POST",
        { timeout: input.waitReadyMs },
      );
      const clock: MeasurementClock = {
        startedAt: performance.now(),
        startedAtUnixMs: Date.now(),
      };
      const clickPromise = this.startButton().click({
        timeout: input.waitReadyMs,
      });
      const clickOutcome = clickPromise.then(
        () => null,
        (error: unknown) =>
          error instanceof Error ? error : new Error(errorMessage(error)),
      );

      let response;
      try {
        response = await responsePromise;
      } catch (error) {
        if (routeFailure) throw routeFailure;
        throw error;
      }
      const acceptedMs = elapsedMs(clock.startedAt);
      let start: StartRunResponse;
      try {
        start = await parseBrowserStartResponse(
          response,
          this.scenarioId,
          clock,
        );
        this.apiPolicy.claimOwnedRun(start.runId);
      } catch (error) {
        // Keep the host-pinning route installed until the browser click has
        // completely settled, even when an accepted response is malformed.
        // AcceptedRunContractError still carries the run identity so the
        // caller can destroy the run before surfacing the contract failure.
        await clickOutcome;
        throw error;
      }
      const terminalWait = this.waitForUsableTerminal({
        runId: start.runId,
        marker: input.marker,
        clock,
        waitReadyMs: input.waitReadyMs,
        terminalProbeTimeoutMs: input.terminalProbeTimeoutMs,
      });
      void terminalWait.catch(() => undefined);
      const clickError = await clickOutcome;
      const postAcceptanceFailure =
        routeFailure ??
        clickError ??
        (routeHits !== 1
          ? new Error(
              `expected exactly one injected scenario start request, observed ${routeHits}`,
            )
          : null);
      const terminal = postAcceptanceFailure
        ? Promise.reject<BrowserTerminalObservation>(postAcceptanceFailure)
        : terminalWait;
      void terminal.catch(() => undefined);
      return { clock, start, acceptedMs, terminal };
    } finally {
      await this.page.unroute(endpoint, routeHandler).catch(() => undefined);
    }
  }

  async resetAfterSample(): Promise<void> {
    await this.page.goto("about:blank", {
      waitUntil: "commit",
      timeout: 10_000,
    });
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private startButton() {
    return this.page.getByRole("button", {
      name: "Start scenario",
      exact: true,
    });
  }

  private async waitForUsableTerminal(input: {
    runId: string;
    marker: string;
    clock: MeasurementClock;
    waitReadyMs: number;
    terminalProbeTimeoutMs: number;
  }): Promise<BrowserTerminalObservation> {
    await this.page.waitForURL(
      (url) =>
        url.origin === this.origin &&
        url.pathname === `/runs/${encodeURIComponent(input.runId)}`,
      { timeout: input.waitReadyMs },
    );
    const terminalRegion = this.page.locator('section[aria-label="Terminal"]');
    const xterm = terminalRegion.locator(".xterm");
    await xterm.waitFor({ state: "visible", timeout: input.waitReadyMs });
    const uiTerminalReadyAtUnixMs = Date.now();
    const uiTerminalReadyMs = elapsedMs(input.clock.startedAt);

    const status = terminalRegion
      .getByRole("status")
      .filter({ hasText: /^Terminal status:/i });
    await waitForLocatorText({
      locator: status,
      expected: /^Terminal status:\s*connected$/i,
      timeoutMs: input.terminalProbeTimeoutMs,
      label: "connected terminal status",
    });
    const terminalWebsocketReadyAtUnixMs = Date.now();
    const terminalWebsocketReadyMs = elapsedMs(input.clock.startedAt);

    await xterm.click({ timeout: input.terminalProbeTimeoutMs });
    await this.page.keyboard.type(browserMarkerCommand(input.marker));
    await this.page.keyboard.press("Enter");
    await waitForLocatorContainsText({
      locator: terminalRegion.locator(".xterm-rows"),
      expected: input.marker,
      timeoutMs: input.terminalProbeTimeoutMs,
      label: "usable-terminal marker",
    });
    return {
      uiTerminalReadyMs,
      uiTerminalReadyAtUnixMs,
      terminalWebsocketReadyMs,
      terminalWebsocketReadyAtUnixMs,
      usableTerminalMs: elapsedMs(input.clock.startedAt),
    };
  }
}

async function parseBrowserStartResponse(
  response: Awaited<ReturnType<Page["waitForResponse"]>>,
  expectedScenarioId: string,
  clock: MeasurementClock,
): Promise<StartRunResponse> {
  const responseText = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(
      `scenario start returned non-JSON HTTP ${response.status()}`,
    );
  }
  if (!response.ok()) {
    throw new Error(
      `scenario start failed with HTTP ${response.status()}: ${responseText.slice(0, 500)}`,
    );
  }
  if (!isRecord(value)) {
    throw new Error("scenario start response is not an object");
  }
  const acceptedRun =
    value.accepted === true &&
    typeof value.runId === "string" &&
    value.runId.trim() &&
    typeof value.reused === "boolean"
      ? { runId: value.runId, reused: value.reused }
      : null;
  if (
    value.accepted !== true ||
    typeof value.runId !== "string" ||
    !value.runId.trim() ||
    value.scenarioId !== expectedScenarioId ||
    !Number.isSafeInteger(value.acceptedAt) ||
    Number(value.acceptedAt) <= 0 ||
    typeof value.reused !== "boolean"
  ) {
    if (acceptedRun) {
      throw new AcceptedRunContractError({
        message: "scenario start response violates the benchmark contract",
        clock,
        runId: acceptedRun.runId,
        reused: acceptedRun.reused,
      });
    }
    throw new Error("scenario start response violates the benchmark contract");
  }
  return {
    accepted: true,
    runId: value.runId,
    scenarioId: expectedScenarioId,
    acceptedAt: Number(value.acceptedAt),
    reused: value.reused,
  };
}

async function waitForLocatorText(input: {
  locator: ReturnType<Page["locator"]>;
  expected: RegExp;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  const deadline = performance.now() + input.timeoutMs;
  let lastText = "";
  while (performance.now() <= deadline) {
    const texts = await input.locator.allTextContents().catch(() => []);
    const matching = texts.find((text) => input.expected.test(text.trim()));
    if (matching !== undefined) return;
    lastText = texts.join(" | ");
    await sleep(25);
  }
  throw new Error(
    `timed out waiting for ${input.label}; last text was ${JSON.stringify(lastText)}`,
  );
}

async function waitForLocatorContainsText(input: {
  locator: ReturnType<Page["locator"]>;
  expected: string;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  const deadline = performance.now() + input.timeoutMs;
  while (performance.now() <= deadline) {
    const text = (await input.locator.allTextContents().catch(() => [])).join(
      "\n",
    );
    if (text.includes(input.expected)) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${input.label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const options = parseBootBenchmarkOptions(process.argv.slice(2), process.env);
  const result = await runBootBenchmark(options);
  await writeBenchmarkResult(options.outputPath, result);
  const distribution = result.summary.usable_terminal_ms;
  log(
    `result ${result.promotion.passed ? "PASS" : "FAIL"}: p50=${distribution?.p50_ms ?? "n/a"}ms p95=${distribution?.p95_ms ?? "n/a"}ms output=${options.outputPath}`,
  );
  if (!result.promotion.passed) {
    result.promotion.reasons.forEach((reason) => log(`gate: ${reason}`));
    process.exitCode = 1;
  }
}

export async function runBootBenchmark(
  options: BootBenchmarkOptions,
): Promise<BootBenchmarkResultV1> {
  const manifestText = await readFile(options.manifestPath, "utf8");
  const manifest = parseManifest(
    JSON.parse(manifestText) as unknown,
    options.manifestPath,
  );
  if (manifest.vms.length !== 1) {
    throw new Error(
      `boot benchmark requires a one-VM scenario manifest, got ${manifest.vms.length}`,
    );
  }
  if (manifest.scenario_id !== "broken-nginx") {
    throw new Error(
      `promotion benchmark requires broken-nginx, got ${manifest.scenario_id}`,
    );
  }
  const cpuPolicy = BOOT_BENCHMARK_CPU_POLICIES[options.variant];
  assertLiveRunnerVariant(options.variant);
  const manifestVm = manifest.vms[0]!;
  if (
    manifestVm.cpu_millis !== 1_000 ||
    manifestVm.vcpu_count !== 1 ||
    manifestVm.disk_mib !== 4_096
  ) {
    throw new Error(
      `broken-nginx promotion contract must be 1000m/1-vCPU/4096MiB, got ${manifestVm.cpu_millis}m/${manifestVm.vcpu_count}-vCPU/${manifestVm.disk_mib}MiB`,
    );
  }

  const apiPolicy = new BootBenchmarkApiPolicy({
    origin: options.baseUrl,
    hostId: options.hostId,
    scenarioId: manifest.scenario_id,
  });
  const client = new ApiClient(options.baseUrl, options.auth, apiPolicy);
  const artifacts = bootArtifactIdentity(manifest);
  const artifactFingerprint = bootArtifactFingerprint(artifacts);
  const host = await loadHostEvidence({
    client,
    hostId: options.hostId,
    manifest,
    requireIdle: true,
  });
  if (
    options.cloudHypervisorSha256 &&
    options.cloudHypervisorSha256.toLowerCase() !== host.cloudHypervisorSha256
  ) {
    throw new FatalIsolationError(
      `operator Cloud Hypervisor hash ${options.cloudHypervisorSha256} does not match host attestation ${host.cloudHypervisorSha256}`,
    );
  }
  log(
    `preflight ready: host=${options.hostId} scenario=${manifest.scenario_id} variant=${options.variant} artifact=${artifactFingerprint.slice(0, 12)}`,
  );

  const prewarmReadyAt = Math.max(
    ...host.cachedImages.map((image) => image.ready_at_unix_ms),
  );
  if (
    options.coldPrewarmStartedAtUnixMs !== null &&
    options.coldPrewarmStartedAtUnixMs > prewarmReadyAt
  ) {
    throw new FatalIsolationError(
      `cold prewarm start ${options.coldPrewarmStartedAtUnixMs} is after the host-attested ready timestamp ${prewarmReadyAt}`,
    );
  }

  const warmups: BootSampleV1[] = [];
  const measured: BootSampleV1[] = [];
  const browserDriver = await BrowserBenchmarkDriver.create({
    baseUrl: options.baseUrl,
    auth: options.auth,
    apiPolicy,
    browserSession: options.browserSession,
    hostId: options.hostId,
    scenarioId: manifest.scenario_id,
  });
  try {
    for (let index = 0; index < options.warmups; index += 1) {
      log(`warmup ${index + 1}/${options.warmups}`);
      warmups.push(
        await measureBoot({
          browserDriver,
          client,
          options,
          manifest,
          expectedHost: host,
          kind: "warmup",
          ordinal: index + 1,
        }),
      );
    }
    for (let index = 0; index < options.measuredSamples; index += 1) {
      log(`measured ${index + 1}/${options.measuredSamples}`);
      measured.push(
        await measureBoot({
          browserDriver,
          client,
          options,
          manifest,
          expectedHost: host,
          kind: "measured",
          ordinal: index + 1,
        }),
      );
    }
  } finally {
    await browserDriver.close();
  }

  const summary = summarizeBootSamples({ warmups, measured });
  const promotion = evaluatePromotionGate({
    warmups,
    measured,
    summary,
    performanceReady: host.performanceReady,
    cpuPolicy,
  });
  return {
    schema_version: BOOT_BENCHMARK_SCHEMA_VERSION,
    generated_at_unix_ms: Date.now(),
    variant: options.variant,
    scenario_id: manifest.scenario_id,
    host_id: options.hostId,
    base_url_origin: new URL(options.baseUrl).origin,
    manifest_path: resolve(options.manifestPath),
    implementation_sha256: options.implementationSha256,
    artifact_fingerprint_sha256: artifactFingerprint,
    artifacts,
    cloud_hypervisor_sha256: host.cloudHypervisorSha256,
    browser: {
      automation: "playwright",
      playwright_version: PLAYWRIGHT_VERSION,
      browser_name: "chromium",
      chromium_version: browserDriver.chromiumVersion,
      headless: true,
      context_reused: true,
      page_reused: true,
      measurement_boundary: BOOT_BENCHMARK_MEASUREMENT_BOUNDARY,
    },
    cpu_policy: cpuPolicy,
    host: {
      agent_version: host.agentVersion,
      observed_at_unix_ms: host.observedAt,
      capabilities: host.capabilities,
      performance_ready: host.performanceReady,
    },
    prewarm: {
      ready_before_benchmark: true,
      host_observed_at_unix_ms: host.observedAt,
      cached_images: host.cachedImages,
      cold:
        options.coldPrewarmStartedAtUnixMs === null
          ? null
          : {
              started_at_unix_ms: options.coldPrewarmStartedAtUnixMs,
              ready_at_unix_ms: prewarmReadyAt,
              duration_ms: prewarmReadyAt - options.coldPrewarmStartedAtUnixMs,
            },
    },
    parameters: {
      warmups: options.warmups,
      measured_samples: options.measuredSamples,
      poll_ms: options.pollMs,
      wait_ready_ms: options.waitReadyMs,
      wait_idle_ms: options.waitIdleMs,
      terminal_probe_timeout_ms: options.terminalProbeTimeoutMs,
    },
    isolation: {
      admission_mode: "benchmark",
      host_scenario_enabled: false,
      preflight_idle_required: true,
      preflight_actual_state_drained: true,
      preflight_desired_state_drained: true,
      preflight_desired_state_applied: true,
      continuous_foreign_vm_monitor: true,
      continuous_foreign_desired_vm_monitor: true,
      continuous_scheduling_disabled_monitor: true,
      authoritative_vm_source: "host_desired_and_actual_state",
      monitor_poll_max_ms: Math.min(options.pollMs, 250),
      atomic_host_lease: true,
    },
    warmups,
    measured,
    summary,
    promotion,
  };
}

export function assertLiveRunnerVariant(variant: BootBenchmarkVariant): void {
  if (BOOT_BENCHMARK_CPU_POLICIES[variant].kind !== "boot_lease") {
    throw new Error(
      `the breaking v2 live runner cannot execute historical variant ${variant}; compare a previously captured same-host result artifact instead`,
    );
  }
}

async function measureBoot(input: {
  browserDriver: BrowserBenchmarkDriver;
  client: ApiClient;
  options: BootBenchmarkOptions;
  manifest: ReturnType<typeof parseManifest>;
  expectedHost: HostEvidence;
  kind: "warmup" | "measured";
  ordinal: number;
}): Promise<BootSampleV1> {
  const sampleHost = await loadHostEvidence({
    client: input.client,
    hostId: input.options.hostId,
    manifest: input.manifest,
    requireIdle: true,
  });
  assertStableHostEvidence(sampleHost, input.expectedHost);

  let startedAtUnixMs = Date.now();
  let startedAt = performance.now();
  let runId: string | null = null;
  let ownedRun = false;
  let passed: Omit<PassedBootSampleV1, "teardown_ms"> | null = null;
  let failure: string | null = null;
  let failureElapsedMs: number | null = null;
  let fatalFailure: FatalIsolationError | null = null;
  let isolationMonitor: IsolationMonitor | null = null;
  const measurementAbort = new AbortController();

  try {
    await input.browserDriver.prepareScenario(input.options.waitReadyMs);
    const browserStart = await input.browserDriver.clickStart({
      marker: benchmarkMarker(input.kind, input.ordinal),
      waitReadyMs: input.options.waitReadyMs,
      terminalProbeTimeoutMs: input.options.terminalProbeTimeoutMs,
    });
    const { start } = browserStart;
    startedAtUnixMs = browserStart.clock.startedAtUnixMs;
    startedAt = browserStart.clock.startedAt;
    runId = start.runId;
    if (start.reused) {
      throw new FatalIsolationError(
        `start reused active run ${start.runId}; benchmark will not destroy a run it did not create`,
      );
    }
    ownedRun = true;
    isolationMonitor = startIsolationMonitor({
      client: input.client,
      hostId: input.options.hostId,
      runId: start.runId,
      pollMs: input.options.pollMs,
      expectedHost: input.expectedHost,
    });
    const readyObservationPromise = waitForRunReady(
      input.client,
      start.runId,
      input.options,
      input.manifest.vms[0]!,
      measurementAbort.signal,
    ).then((run) => ({
      run,
      projectionObservedAtUnixMs: Date.now(),
      terminalReportReadyMs: elapsedMs(startedAt),
    }));
    const [readyObservation, browserTerminal] = await Promise.all([
      withIsolationGuard(readyObservationPromise, isolationMonitor),
      withIsolationGuard(browserStart.terminal, isolationMonitor),
    ]);
    const {
      run: ready,
      projectionObservedAtUnixMs,
      terminalReportReadyMs,
    } = readyObservation;
    const vm = ready.vms[0]!;
    const hostActualVms = await withIsolationGuard(
      loadAuthoritativeHostVms(
        input.client,
        input.options.hostId,
        start.runId,
        input.expectedHost,
      ),
      isolationMonitor,
    );
    assertOwnedHostActualVm(hostActualVms, start.runId);
    const cpuEvidence = await withIsolationGuard(
      loadVmCpuEvidence({
        client: input.client,
        runId: start.runId,
        vmName: vm.runtimeVmName,
        generation: vm.runtimeConstraints!.generation,
        cpuPolicy: BOOT_BENCHMARK_CPU_POLICIES[input.options.variant],
        timeoutMs: 30_000,
        pollMs: Math.min(input.options.pollMs, 100),
      }),
      isolationMonitor,
    );
    const { bootEvidence, ...runtimeCpuEvidence } = cpuEvidence;
    const constraints = vm.runtimeConstraints!;
    const phaseEvidence = buildPhaseEvidence({
      run: ready,
      vm,
      startedAtUnixMs,
      projectionObservedAtUnixMs,
      uiTerminalReadyAtUnixMs: browserTerminal.uiTerminalReadyAtUnixMs,
      terminalWebsocketReadyAtUnixMs:
        browserTerminal.terminalWebsocketReadyAtUnixMs,
    });
    passed = {
      kind: input.kind,
      ordinal: input.ordinal,
      status: "passed",
      run_id: start.runId,
      started_at_unix_ms: startedAtUnixMs,
      server_accepted_at_unix_ms: start.acceptedAt,
      accepted_ms: browserStart.acceptedMs,
      terminal_report_ready_ms: terminalReportReadyMs,
      ui_terminal_ready_ms: browserTerminal.uiTerminalReadyMs,
      terminal_websocket_ready_ms: browserTerminal.terminalWebsocketReadyMs,
      usable_terminal_ms: browserTerminal.usableTerminalMs,
      seal_projection_ready_ms: sealProjectionReadyDurationMs(
        bootEvidence,
        terminalReportReadyMs,
      ),
      seal_projection_ui_ready_ms: sealProjectionUiReadyDurationMs(
        bootEvidence,
        browserTerminal.uiTerminalReadyMs,
      ),
      phase_evidence: phaseEvidence,
      runtime_evidence: {
        generation: constraints.generation,
        phase: "steady",
        steady_cpu_millis: constraints.steadyCpuMillis,
        effective_cpu_millis: constraints.effectiveCpuMillis,
        quota_verified_at_unix_ms: constraints.quotaVerifiedAt!,
        lease_expires_at_unix_ms: constraints.leaseExpiresAt,
      },
      host_boot_evidence: bootEvidence,
      cpu_evidence: runtimeCpuEvidence,
    };
  } catch (error) {
    if (error instanceof AcceptedRunContractError) {
      startedAtUnixMs = error.clock.startedAtUnixMs;
      startedAt = error.clock.startedAt;
      runId = error.runId;
      ownedRun = !error.reused;
      failure = error.message;
      failureElapsedMs = elapsedMs(startedAt);
    } else if (error instanceof FatalIsolationError) {
      fatalFailure = error;
    } else {
      failure = errorMessage(error);
      failureElapsedMs = elapsedMs(startedAt);
    }
  }

  measurementAbort.abort();

  let browserResetFailure: string | null = null;
  try {
    await input.browserDriver.resetAfterSample();
  } catch (error) {
    browserResetFailure = errorMessage(error);
  }

  const teardownStartedAt = performance.now();
  let teardownFailure: string | null = null;
  if (ownedRun && runId) {
    try {
      await destroyAndWaitForIsolation(
        input.client,
        input.options,
        runId,
        isolationMonitor,
      );
    } catch (error) {
      teardownFailure = errorMessage(error);
    }
  }
  const teardownMs = elapsedMs(teardownStartedAt);
  const monitorFailure = isolationMonitor?.failureReason() ?? null;
  let isolationEvidence: PassedBootSampleV1["isolation_evidence"];
  if (passed && isolationMonitor && !monitorFailure && !teardownFailure) {
    try {
      isolationEvidence = isolationMonitor.evidence();
    } catch (error) {
      teardownFailure = errorMessage(error);
    }
  }
  isolationMonitor?.stop();

  if (teardownFailure) {
    throw new FatalIsolationError(
      `could not restore host isolation after ${input.kind} ${input.ordinal}: ${teardownFailure}`,
    );
  }

  if (browserResetFailure) {
    throw new FatalIsolationError(
      `could not close the browser terminal before teardown: ${browserResetFailure}`,
    );
  }

  if (monitorFailure) throw monitorFailure;
  if (fatalFailure) throw fatalFailure;

  if (passed) {
    log(
      `${input.kind} ${input.ordinal} passed: accepted=${passed.accepted_ms}ms ready=${passed.terminal_report_ready_ms}ms usable=${passed.usable_terminal_ms}ms`,
    );
    return {
      ...passed,
      isolation_evidence: isolationEvidence!,
      teardown_ms: teardownMs,
    };
  }
  const failed: BootSampleV1 = {
    kind: input.kind,
    ordinal: input.ordinal,
    status: "failed",
    run_id: runId,
    started_at_unix_ms: startedAtUnixMs,
    elapsed_ms: failureElapsedMs ?? elapsedMs(startedAt),
    error: failure ?? "boot measurement failed",
    teardown_ms: ownedRun ? teardownMs : null,
  };
  log(`${input.kind} ${input.ordinal} failed: ${failed.error}`);
  return failed;
}

async function waitForRunReady(
  client: ApiClient,
  runId: string,
  options: BootBenchmarkOptions,
  expectedVm: ReturnType<typeof parseManifest>["vms"][number],
  signal: AbortSignal,
): Promise<ScenarioRunRecord> {
  const deadline = Date.now() + options.waitReadyMs;
  let lastDetail = "run not observed";
  while (Date.now() <= deadline) {
    const { run } = await client.json<RunResponse>(
      `/api/scenarios/runs/${encodeURIComponent(runId)}`,
      { signal },
    );
    if (run.phase === "failed") {
      throw new Error(
        `run failed before terminal readiness: ${run.phaseDetail}`,
      );
    }
    if (run.vms.length !== 1) {
      throw new Error(`expected one runtime VM, got ${run.vms.length}`);
    }
    const vm = run.vms[0]!;
    const constraints = vm.runtimeConstraints;
    if (hasBootBenchmarkReadyVm(run, expectedVm.cpu_millis)) return run;
    lastDetail = `${run.phase}/${vm.phase}: terminal=${vm.terminalPhase} cpu=${constraints?.phase ?? "missing"}`;
    await abortableSleep(options.pollMs, signal);
  }
  throw new Error(`timed out waiting for terminal readiness: ${lastDetail}`);
}

export function hasBootBenchmarkReadyVm(
  run: ScenarioRunRecord,
  expectedCpuMillis: number,
): boolean {
  if (run.vms.length !== 1) return false;
  const vm = run.vms[0]!;
  const constraints = vm.runtimeConstraints;
  return Boolean(
    run.canOpenTerminal &&
    vm.canOpenTerminal &&
    vm.terminalPhase === "ready" &&
    vm.terminalTarget.host &&
    vm.terminalTarget.port > 0 &&
    vm.terminalTarget.hostKeyOpenssh &&
    typeof vm.vmCreatedAt === "number" &&
    typeof vm.runtimeObservedAt === "number" &&
    typeof vm.terminalObservedAt === "number" &&
    typeof vm.terminalTarget.checkedAt === "number" &&
    constraints?.generation.trim() &&
    constraints.phase === "steady" &&
    constraints.steadyCpuMillis === expectedCpuMillis &&
    constraints.effectiveCpuMillis === expectedCpuMillis &&
    typeof constraints.quotaVerifiedAt === "number" &&
    constraints.quotaVerifiedAt > 0,
  );
}

function buildPhaseEvidence(input: {
  run: ScenarioRunRecord;
  vm: ScenarioRunRecord["vms"][number];
  startedAtUnixMs: number;
  projectionObservedAtUnixMs: number;
  uiTerminalReadyAtUnixMs: number;
  terminalWebsocketReadyAtUnixMs: number;
}): PassedBootSampleV1["phase_evidence"] {
  const vmCreatedAt = input.vm.vmCreatedAt!;
  const quotaVerifiedAt = input.vm.runtimeConstraints!.quotaVerifiedAt!;
  const runtimeObservedAt = input.vm.runtimeObservedAt!;
  const terminalObservedAt = input.vm.terminalObservedAt!;
  const sshVerifiedAt = input.vm.terminalTarget.checkedAt!;
  const offset = (timestamp: number) => timestamp - input.startedAtUnixMs;
  return {
    run_created_at_unix_ms: input.run.createdAt,
    vm_created_at_unix_ms: vmCreatedAt,
    quota_verified_at_unix_ms: quotaVerifiedAt,
    runtime_report_observed_at_unix_ms: runtimeObservedAt,
    terminal_report_observed_at_unix_ms: terminalObservedAt,
    ssh_verified_at_unix_ms: sshVerifiedAt,
    projection_observed_at_unix_ms: input.projectionObservedAtUnixMs,
    ui_terminal_ready_at_unix_ms: input.uiTerminalReadyAtUnixMs,
    terminal_websocket_ready_at_unix_ms: input.terminalWebsocketReadyAtUnixMs,
    offsets_ms: {
      run_created: offset(input.run.createdAt),
      vm_created: offset(vmCreatedAt),
      quota_verified: offset(quotaVerifiedAt),
      runtime_report_observed: offset(runtimeObservedAt),
      terminal_report_observed: offset(terminalObservedAt),
      ssh_verified: offset(sshVerifiedAt),
      projection_observed: offset(input.projectionObservedAtUnixMs),
      ui_terminal_ready: offset(input.uiTerminalReadyAtUnixMs),
      terminal_websocket_ready: offset(input.terminalWebsocketReadyAtUnixMs),
    },
  };
}

async function loadVmCpuEvidence(input: {
  client: ApiClient;
  runId: string;
  vmName: string;
  generation: string;
  cpuPolicy: BootBenchmarkResultV1["cpu_policy"];
  timeoutMs: number;
  pollMs: number;
}): Promise<
  PassedBootSampleV1["cpu_evidence"] & {
    bootEvidence: PassedBootSampleV1["host_boot_evidence"];
  }
> {
  const deadline = Date.now() + input.timeoutMs;
  let vm: ScenarioRunRecord["vms"][number] | undefined;
  do {
    const { run } = await input.client.json<RunResponse>(
      `/api/scenarios/runs/${encodeURIComponent(input.runId)}`,
    );
    vm = run.vms.find((candidate) => candidate.runtimeVmName === input.vmName);
    if (
      vm?.bootEvidence?.generation === input.generation &&
      hasExactBootCpuSamples(vm.bootEvidence, input.cpuPolicy) &&
      vm.runtimeConstraints?.generation === input.generation &&
      hasExactSteadyResourceState(vm.resourceState ?? null, input.cpuPolicy)
    ) {
      break;
    }
    if (Date.now() <= deadline) await sleep(input.pollMs);
  } while (Date.now() <= deadline);
  const bootEvidence =
    vm?.bootEvidence?.generation === input.generation &&
    hasExactBootCpuSamples(vm.bootEvidence, input.cpuPolicy)
      ? vm.bootEvidence
      : null;
  const resourceState =
    vm?.runtimeConstraints?.generation === input.generation
      ? (vm.resourceState ?? null)
      : null;
  const hasEvidence = bootEvidence !== null || resourceState !== null;
  return {
    status: hasEvidence ? "available" : "unavailable",
    observed_at_unix_ms: vm?.runtimeObservedAt ?? null,
    generation: input.generation,
    resource_state: resourceState,
    unavailable_reason: hasEvidence
      ? null
      : vm
        ? "latest host inventory did not include matching-generation boot or cgroup evidence"
        : "latest host inventory did not yet include the measured VM",
    bootEvidence,
  };
}

export function assertNoForeignHostActualVms(
  vms: readonly HostActualVm[],
  ownedRunId: string,
): void {
  const foreign = vms.filter((vm) => vm.run_id !== ownedRunId);
  if (foreign.length > 0) {
    throw new FatalIsolationError(
      `foreign VM(s) appeared on the benchmark host: ${foreign
        .map(
          (vm) =>
            `${vm.vm_name}[${vm.run_id.trim() || "unattributed"}:${vm.phase}]`,
        )
        .join(",")}`,
    );
  }
}

export function assertOwnedHostActualVm(
  vms: readonly HostActualVm[],
  ownedRunId: string,
): void {
  assertNoForeignHostActualVms(vms, ownedRunId);
  if (!vms.some((vm) => vm.run_id === ownedRunId)) {
    throw new FatalIsolationError(
      `benchmark run ${ownedRunId} was not observed on the pinned host`,
    );
  }
}

async function loadAuthoritativeHostVms(
  client: ApiClient,
  hostId: string,
  ownedRunId: string,
  expectedHost: HostEvidence,
): Promise<HostActualVm[]> {
  const { host } = await client.json<HostResponse>(
    `/api/agent/hosts/${encodeURIComponent(hostId)}`,
  );
  return assertAuthoritativeHostSnapshot(host, {
    hostId,
    ownedRunId,
    expectedHost,
    allowLeaseRelease: false,
  });
}

function assertAuthoritativeHostSnapshot(
  host: HostResponse["host"],
  input: {
    hostId: string;
    ownedRunId: string;
    expectedHost: HostEvidence;
    allowLeaseRelease: boolean;
  },
): HostActualVm[] {
  if (host.id !== input.hostId) {
    throw new FatalIsolationError(
      `host actual-state lookup returned ${host.id}, expected ${input.hostId}`,
    );
  }
  if (!host.status.connected) {
    throw new FatalIsolationError(
      "benchmark host bridge disconnected during isolation monitoring",
    );
  }
  if (host.scenarioEnabled) {
    throw new FatalIsolationError(
      "benchmark host was re-enabled for ordinary scenario scheduling",
    );
  }
  if (
    host.benchmarkLease?.runId !== input.ownedRunId &&
    !(input.allowLeaseRelease && host.benchmarkLease === null)
  ) {
    throw new FatalIsolationError(
      host.benchmarkLease
        ? `benchmark host lease belongs to ${host.benchmarkLease.runId}, expected ${input.ownedRunId}`
        : `benchmark host lease for ${input.ownedRunId} disappeared before teardown`,
    );
  }
  if (!host.actualState || host.actualState.health !== "healthy") {
    throw new FatalIsolationError(
      `benchmark host actual state is ${host.actualState?.health ?? "missing"}`,
    );
  }
  if (!host.desiredState) {
    throw new FatalIsolationError(
      "benchmark host desired state is missing during isolation monitoring",
    );
  }
  assertStableHostResponse(host, input.expectedHost);
  const foreignDesired = host.desiredState.vms.filter(
    (vm) => vm.desired_phase === "running" && vm.run_id !== input.ownedRunId,
  );
  if (foreignDesired.length > 0) {
    throw new FatalIsolationError(
      `foreign desired VM(s) appeared on the benchmark host: ${foreignDesired
        .map(
          (vm) =>
            `${vm.vm_name}[${vm.run_id.trim() || "unattributed"}:${vm.desired_phase}]`,
        )
        .join(",")}`,
    );
  }
  assertNoForeignHostActualVms(host.actualState.vms, input.ownedRunId);
  return host.actualState.vms;
}

function startIsolationMonitor(input: {
  client: ApiClient;
  hostId: string;
  runId: string;
  pollMs: number;
  expectedHost: HostEvidence;
}): IsolationMonitor {
  let stopped = false;
  let teardown = false;
  let leaseReleased = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectFailure!: (error: FatalIsolationError) => void;
  let recordedFailure: FatalIsolationError | null = null;
  let firstOwnedObservedAt: number | null = null;
  let lastOwnedObservedAt: number | null = null;
  let releasedObservedAt: number | null = null;
  let observationCount = 0;
  let recordFailure!: (error: FatalIsolationError) => void;
  let attest!: (host: HostResponse["host"]) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
    const poll = async () => {
      if (stopped) return;
      try {
        const { host } = await input.client.json<HostResponse>(
          `/api/agent/hosts/${encodeURIComponent(input.hostId)}`,
        );
        if (stopped) return;
        attest(host);
      } catch (error) {
        recordFailure(
          error instanceof FatalIsolationError
            ? error
            : new FatalIsolationError(
                `could not continuously attest benchmark host isolation: ${errorMessage(error)}`,
              ),
        );
        return;
      }
      timer = setTimeout(poll, Math.min(input.pollMs, 250));
    };
    void poll();
  });
  recordFailure = (error: FatalIsolationError) => {
    if (recordedFailure) return;
    recordedFailure = error;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    rejectFailure(error);
  };
  attest = (host: HostResponse["host"]) => {
    if (recordedFailure) return;
    try {
      assertAuthoritativeHostSnapshot(host, {
        hostId: input.hostId,
        ownedRunId: input.runId,
        expectedHost: input.expectedHost,
        allowLeaseRelease: teardown,
      });
      const observedAt = Date.now();
      observationCount += 1;
      if (host.benchmarkLease?.runId === input.runId) {
        if (leaseReleased) {
          throw new FatalIsolationError(
            `benchmark lease for ${input.runId} reappeared after drained release`,
          );
        }
        firstOwnedObservedAt ??= observedAt;
        lastOwnedObservedAt = observedAt;
      } else {
        if (!teardown) {
          throw new FatalIsolationError(
            `benchmark lease for ${input.runId} released before destroy`,
          );
        }
        leaseReleased = true;
        releasedObservedAt ??= observedAt;
      }
    } catch (error) {
      recordFailure(
        error instanceof FatalIsolationError
          ? error
          : new FatalIsolationError(errorMessage(error)),
      );
    }
  };
  return {
    failure,
    beginTeardown: () => {
      teardown = true;
    },
    attest,
    evidence: () => {
      if (
        firstOwnedObservedAt === null ||
        lastOwnedObservedAt === null ||
        releasedObservedAt === null ||
        observationCount < 2
      ) {
        throw new FatalIsolationError(
          `benchmark lease transition evidence is incomplete for ${input.runId}`,
        );
      }
      return {
        lease_run_id: input.runId,
        first_owned_observed_at_unix_ms: firstOwnedObservedAt,
        last_owned_observed_at_unix_ms: lastOwnedObservedAt,
        released_observed_at_unix_ms: releasedObservedAt,
        observation_count: observationCount,
      };
    },
    failureReason: () => recordedFailure,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

async function withIsolationGuard<T>(
  operation: Promise<T>,
  monitor: IsolationMonitor,
): Promise<T> {
  return Promise.race([operation, monitor.failure]);
}

async function destroyAndWaitForIsolation(
  client: ApiClient,
  options: BootBenchmarkOptions,
  runId: string,
  isolationMonitor: IsolationMonitor | null,
): Promise<void> {
  isolationMonitor?.beginTeardown();
  await client.json(
    `/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`,
    { method: "POST" },
  );
  const deadline = Date.now() + options.waitIdleMs;
  let lastDetail = "cleanup not observed";
  while (Date.now() <= deadline) {
    const [runResult, hostResult] = await Promise.allSettled([
      client.json<RunResponse>(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
      ),
      client.json<HostResponse>(
        `/api/agent/hosts/${encodeURIComponent(options.hostId)}`,
      ),
    ]);
    if (runResult.status === "fulfilled" && hostResult.status === "fulfilled") {
      isolationMonitor?.attest(hostResult.value.host);
      const terminalRun = ["completed", "failed"].includes(
        runResult.value.run.phase,
      );
      const committed =
        hostResult.value.host.actualState?.capacity.committed_cpu_millis;
      const actualVms = hostResult.value.host.actualState?.vms ?? null;
      const actualAppliedVersion =
        hostResult.value.host.actualState?.appliedDesiredVersion ?? null;
      const desiredState = hostResult.value.host.desiredState;
      const desiredRunningVms =
        desiredState?.vms.filter((vm) => vm.desired_phase === "running") ??
        null;
      const desiredApplied =
        desiredState !== null &&
        actualAppliedVersion !== null &&
        actualAppliedVersion >= desiredState.version;
      if (
        terminalRun &&
        committed === 0 &&
        actualVms?.length === 0 &&
        desiredRunningVms?.length === 0 &&
        desiredApplied &&
        hostResult.value.host.benchmarkLease === null
      ) {
        return;
      }
      lastDetail = `run=${runResult.value.run.phase} committed=${String(committed)} actual_vms=${actualVms?.length ?? "missing"} desired_running_vms=${desiredRunningVms?.length ?? "missing"} desired_applied=${String(desiredApplied)} benchmark_lease=${hostResult.value.host.benchmarkLease?.runId ?? "absent"}`;
    } else {
      lastDetail = [runResult, hostResult]
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => errorMessage(result.reason))
        .join("; ");
    }
    await sleep(options.pollMs);
  }
  throw new Error(`timed out waiting for isolated host cleanup: ${lastDetail}`);
}

async function loadHostEvidence(input: {
  client: ApiClient;
  hostId: string;
  manifest: ReturnType<typeof parseManifest>;
  requireIdle: boolean;
}): Promise<HostEvidence> {
  const { host } = await input.client.json<HostResponse>(
    `/api/agent/hosts/${encodeURIComponent(input.hostId)}`,
  );
  const problems: string[] = [];
  const cachedImages: HostEvidence["cachedImages"] = [];
  if (host.id !== input.hostId) problems.push(`API returned host ${host.id}`);
  if (host.role !== "agent") problems.push(`host role is ${host.role}`);
  if (host.disabled) problems.push("host is disabled");
  if (host.scenarioEnabled) {
    problems.push(
      "scenario scheduling must be disabled for benchmark admission",
    );
  }
  if (input.requireIdle && host.benchmarkLease !== null) {
    problems.push(
      `host has benchmark lease for run ${host.benchmarkLease.runId}`,
    );
  }
  if (!host.status.connected) problems.push("host bridge is disconnected");
  if (!host.status.agentVersion?.trim()) {
    problems.push("host bridge did not report an agent version");
  }
  if (!host.actualState) {
    problems.push("host has no actual-state report");
  } else {
    if (host.actualState.health !== "healthy") {
      problems.push(`host actual state is ${host.actualState.health}`);
    }
    if (host.actualState.builds.length > 0) {
      problems.push(
        `host actual state has ${host.actualState.builds.length} active build report(s)`,
      );
    }
    const expectedArch = input.manifest.vms[0]?.image_key.arch;
    if (host.actualState.capabilities.arch !== expectedArch) {
      problems.push(
        `host architecture ${String(host.actualState.capabilities.arch)} does not match ${String(expectedArch)}`,
      );
    }
    for (const capability of REQUIRED_FAST_CAPABILITIES) {
      if (host.actualState.capabilities[capability] !== true) {
        problems.push(`host does not attest ${capability}`);
      }
    }
    const runtimeHash = host.actualState.capabilities.cloud_hypervisor_sha256;
    if (
      typeof runtimeHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(runtimeHash)
    ) {
      problems.push(
        "host does not attest a canonical Cloud Hypervisor SHA-256",
      );
    }
    if (host.actualState.capabilities.boot_cpu_millis !== 2_000) {
      problems.push(
        `host boot CPU policy is ${String(host.actualState.capabilities.boot_cpu_millis)}m, expected 2000m`,
      );
    }
    if (host.actualState.capabilities.boot_cpu_lease_ms !== 45_000) {
      problems.push(
        `host boot CPU lease is ${String(host.actualState.capabilities.boot_cpu_lease_ms)}ms, expected 45000ms`,
      );
    }
    for (const vm of input.manifest.vms) {
      const cached = host.actualState.cachedImages.find(
        (image) =>
          image.image_key.scenario === vm.image_key.scenario &&
          image.image_key.vm === vm.image_key.vm &&
          image.image_key.arch === vm.image_key.arch &&
          image.image_sha256.toLowerCase() === vm.image_sha256.toLowerCase(),
      );
      if (!cached) {
        problems.push(
          `image ${vm.image_key.scenario}/${vm.image_key.vm} is absent from cache report`,
        );
      } else if (cached.phase !== "ready") {
        problems.push(
          `image ${vm.image_key.scenario}/${vm.image_key.vm} is ${cached.phase}${cached.error ? `: ${cached.error}` : ""}`,
        );
      } else if (cached.error) {
        problems.push(
          `image ${vm.image_key.scenario}/${vm.image_key.vm} has a ready-state error: ${cached.error}`,
        );
      } else if (
        !Number.isSafeInteger(cached.updated_at_unix_ms) ||
        cached.updated_at_unix_ms <= 0 ||
        cached.updated_at_unix_ms > host.actualState.observedAt
      ) {
        problems.push(
          `image ${vm.image_key.scenario}/${vm.image_key.vm} has invalid ready timestamp ${String(cached.updated_at_unix_ms)}`,
        );
      } else {
        cachedImages.push({
          scenario: cached.image_key.scenario,
          vm: cached.image_key.vm,
          arch: cached.image_key.arch,
          image_sha256: cached.image_sha256.toLowerCase(),
          ready_at_unix_ms: cached.updated_at_unix_ms,
        });
      }
    }
    if (
      input.requireIdle &&
      host.actualState.capacity.committed_cpu_millis !== 0
    ) {
      problems.push(
        `host has ${host.actualState.capacity.committed_cpu_millis}m committed CPU`,
      );
    }
  }
  if (!host.desiredState) {
    problems.push("host has no desired-state document");
  } else if (!host.actualState) {
    problems.push("host desired state has no matching actual-state fence");
  } else {
    if (host.desiredState.builds.length > 0) {
      problems.push(
        `host desired state has ${host.desiredState.builds.length} active build assignment(s)`,
      );
    }
    if (host.actualState.appliedDesiredVersion < host.desiredState.version) {
      problems.push(
        `host has applied desired version ${host.actualState.appliedDesiredVersion}, expected at least ${host.desiredState.version}`,
      );
    }
    const runningDesired = host.desiredState.vms.filter(
      (vm) => vm.desired_phase === "running",
    );
    if (input.requireIdle && runningDesired.length > 0) {
      problems.push(
        `host desired state has running VMs: ${runningDesired
          .map(
            (vm) =>
              `${vm.vm_name}[${vm.run_id.trim() || "unattributed"}:${vm.desired_phase}]`,
          )
          .join(",")}`,
      );
    }
    for (const vm of input.manifest.vms) {
      if (
        !host.desiredState.cachedImages.some(
          (image) =>
            image.image_key.scenario === vm.image_key.scenario &&
            image.image_key.vm === vm.image_key.vm &&
            image.image_key.arch === vm.image_key.arch &&
            image.image_sha256.toLowerCase() === vm.image_sha256.toLowerCase(),
        )
      ) {
        problems.push(
          `image ${vm.image_key.scenario}/${vm.image_key.vm} is absent from desired cache fencing`,
        );
      }
    }
  }
  if (input.requireIdle && (host.actualState?.vms.length ?? 0) > 0) {
    problems.push(
      `host actual state has VMs: ${host
        .actualState!.vms.map(
          (vm) =>
            `${vm.vm_name}[${vm.run_id.trim() || "unattributed"}:${vm.phase}]`,
        )
        .join(",")}`,
    );
  }
  if (problems.length > 0) {
    throw new FatalIsolationError(
      `host ${input.hostId} is not an isolated performance-ready target: ${problems.join("; ")}`,
    );
  }
  const actual = host.actualState!;
  const capabilities = normalizeCapabilities(actual.capabilities);
  return {
    agentVersion: host.status.agentVersion,
    observedAt: actual.observedAt,
    capabilities,
    cloudHypervisorSha256: String(actual.capabilities.cloud_hypervisor_sha256),
    performanceReady: true,
    cachedImages,
    capabilitiesFingerprint: stableRecordFingerprint(capabilities),
    desiredCachedImagesFingerprint: desiredCachedImagesFingerprint(
      host.desiredState!.cachedImages,
    ),
    actualCachedImagesFingerprint: actualCachedImagesFingerprint(
      actual.cachedImages,
    ),
  };
}

export function parseBootBenchmarkOptions(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
): BootBenchmarkOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const allowed = new Set([
    "base-url",
    "cookie",
    "benchmark-token-file",
    "host",
    "variant",
    "manifest",
    "output",
    "implementation-sha256",
    "cloud-hypervisor-sha256",
    "cold-prewarm-started-at-unix-ms",
    "warmups",
    "samples",
    "poll-ms",
    "wait-ready-ms",
    "wait-idle-ms",
    "terminal-probe-timeout-ms",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const separator = arg.indexOf("=");
    const key = separator >= 0 ? arg.slice(2, separator) : arg.slice(2);
    if (!allowed.has(key)) throw new Error(`unknown option: --${key}`);
    const value = separator >= 0 ? arg.slice(separator + 1) : argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    values.set(key, value);
  }

  const baseUrl =
    values.get("base-url") ??
    env.INTAR_BOOT_BENCH_BASE_URL ??
    env.INTAR_LIVE_BASE_URL ??
    "";
  const cookie =
    values.get("cookie") ??
    env.INTAR_BOOT_BENCH_COOKIE ??
    env.INTAR_LIVE_COOKIE ??
    "";
  const benchmarkTokenFile =
    values.get("benchmark-token-file") ?? env.INTAR_BOOT_BENCH_TOKEN_FILE ?? "";
  const benchmarkToken = readBenchmarkToken(
    env.INTAR_BOOT_BENCH_TOKEN ?? "",
    benchmarkTokenFile,
  );
  const hostId =
    values.get("host") ??
    env.INTAR_BOOT_BENCH_HOST_ID ??
    env.INTAR_LIVE_HOST_ID ??
    "";
  const variant = values.get("variant") ?? env.INTAR_BOOT_BENCH_VARIANT ?? "";
  const manifestPath =
    values.get("manifest") ?? env.INTAR_BOOT_BENCH_MANIFEST ?? "";
  if (!baseUrl)
    throw new Error("--base-url or INTAR_LIVE_BASE_URL is required");
  if (!hostId) throw new Error("--host is required for same-host isolation");
  if (!variant) throw new Error("--variant is required");
  if (!BOOT_BENCHMARK_VARIANTS.includes(variant as BootBenchmarkVariant)) {
    throw new Error(
      `--variant must be one of: ${BOOT_BENCHMARK_VARIANTS.join(", ")}`,
    );
  }
  const { auth, browserSession } = parseBootBenchmarkAuth({
    cookie,
    benchmarkToken,
    benchmarkUserId: env.INTAR_BOOT_BENCH_USER_ID ?? "",
    benchmarkExpiresAtUnixMs: env.INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS ?? "",
    variant: variant as BootBenchmarkVariant,
  });
  if (!manifestPath) throw new Error("--manifest is required");

  const implementationSha256 =
    values.get("implementation-sha256") ??
    env.INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256 ??
    "";
  if (!implementationSha256) {
    throw new Error(
      "--implementation-sha256 or INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256 is required",
    );
  }
  if (!/^[a-fA-F0-9]{64}$/.test(implementationSha256)) {
    throw new Error(
      "--implementation-sha256 must be 64 hexadecimal characters",
    );
  }

  const cloudHypervisorSha256 =
    values.get("cloud-hypervisor-sha256") ??
    env.INTAR_BOOT_BENCH_CLOUD_HYPERVISOR_SHA256 ??
    null;
  if (
    cloudHypervisorSha256 !== null &&
    !/^[a-fA-F0-9]{64}$/.test(cloudHypervisorSha256)
  ) {
    throw new Error(
      "--cloud-hypervisor-sha256 must be 64 hexadecimal characters",
    );
  }
  const outputPath = resolve(
    values.get("output") ??
      env.INTAR_BOOT_BENCH_OUTPUT ??
      `boot-benchmark-${variant}.json`,
  );
  const coldPrewarmStartedAtUnixMs = parseOptionalPositiveInteger(
    values.get("cold-prewarm-started-at-unix-ms") ??
      env.INTAR_BOOT_BENCH_COLD_PREWARM_STARTED_AT_UNIX_MS,
  );
  return {
    baseUrl,
    auth,
    browserSession,
    hostId,
    variant: variant as BootBenchmarkVariant,
    manifestPath: resolve(manifestPath),
    outputPath,
    implementationSha256: implementationSha256.toLowerCase(),
    cloudHypervisorSha256: cloudHypervisorSha256?.toLowerCase() ?? null,
    coldPrewarmStartedAtUnixMs,
    warmups: parseCount(values.get("warmups"), PROMOTION_WARMUP_COUNT, true),
    measuredSamples: parseCount(
      values.get("samples"),
      PROMOTION_SAMPLE_COUNT,
      false,
    ),
    pollMs: parsePositiveInteger(values.get("poll-ms"), 100),
    waitReadyMs: parsePositiveInteger(values.get("wait-ready-ms"), 120_000),
    waitIdleMs: parsePositiveInteger(values.get("wait-idle-ms"), 240_000),
    terminalProbeTimeoutMs: parsePositiveInteger(
      values.get("terminal-probe-timeout-ms"),
      15_000,
    ),
  };
}

function readBenchmarkToken(
  environmentToken: string,
  tokenFile: string,
): string {
  if (environmentToken && tokenFile) {
    throw new Error(
      "INTAR_BOOT_BENCH_TOKEN and INTAR_BOOT_BENCH_TOKEN_FILE/--benchmark-token-file are mutually exclusive",
    );
  }
  if (!tokenFile) return environmentToken;
  try {
    return readFileSync(resolve(tokenFile), "utf8").trim();
  } catch (error) {
    throw new Error(
      `failed to read BootBenchmark token file: ${errorMessage(error)}`,
    );
  }
}

function parseBootBenchmarkAuth(input: {
  cookie: string;
  benchmarkToken: string;
  benchmarkUserId: string;
  benchmarkExpiresAtUnixMs: string;
  variant: BootBenchmarkVariant;
}): {
  auth: ApiClientAuth;
  browserSession: BootBenchmarkBrowserSessionIdentity | null;
} {
  if (input.cookie && input.benchmarkToken) {
    throw new Error(
      "cookie and BootBenchmark token auth are mutually exclusive",
    );
  }
  if (!input.cookie && !input.benchmarkToken) {
    throw new Error(
      "INTAR_BOOT_BENCH_TOKEN, --benchmark-token-file, --cookie, or INTAR_LIVE_COOKIE is required",
    );
  }
  if (
    input.variant === "fully-optimized-current-path" &&
    !input.benchmarkToken
  ) {
    throw new Error(
      "fully-optimized-current-path promotion requires BootBenchmark token auth",
    );
  }
  if (input.benchmarkToken) {
    if (
      input.benchmarkToken !== input.benchmarkToken.trim() ||
      /\s/.test(input.benchmarkToken)
    ) {
      throw new Error("BootBenchmark token must not contain whitespace");
    }
    if (
      new TextEncoder().encode(input.benchmarkToken).byteLength <
      BOOT_BENCHMARK_MIN_TOKEN_BYTES
    ) {
      throw new Error("BootBenchmark token must be at least 32 bytes");
    }
    if (
      !input.benchmarkUserId ||
      input.benchmarkUserId !== input.benchmarkUserId.trim() ||
      /[\u0000-\u001f\u007f]/.test(input.benchmarkUserId)
    ) {
      throw new Error(
        "INTAR_BOOT_BENCH_USER_ID is required for token-mode browser routing",
      );
    }
    const expiresAtUnixMs = Number(input.benchmarkExpiresAtUnixMs);
    const nowUnixMs = Date.now();
    if (
      !Number.isSafeInteger(expiresAtUnixMs) ||
      expiresAtUnixMs <= nowUnixMs ||
      expiresAtUnixMs - nowUnixMs > BOOT_BENCHMARK_MAX_AUTH_TTL_MS ||
      !Number.isFinite(new Date(expiresAtUnixMs).getTime())
    ) {
      throw new Error(
        "INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS must expire within the next three hours",
      );
    }
    return {
      auth: { kind: "boot_benchmark", token: input.benchmarkToken },
      browserSession: {
        userId: input.benchmarkUserId,
        expiresAtUnixMs,
      },
    };
  }
  return {
    auth: { kind: "cookie", cookie: input.cookie },
    browserSession: null,
  };
}

function parseOptionalPositiveInteger(
  value: string | undefined,
): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function parseCount(
  value: string | undefined,
  fallback: number,
  allowZero: boolean,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1) ||
    parsed > 10_000
  ) {
    throw new Error(`invalid benchmark count: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function normalizeCapabilities(
  capabilities: Record<string, unknown>,
): Record<string, boolean | string | number | null> {
  return Object.fromEntries(
    Object.entries(capabilities)
      .filter(([, value]) =>
        ["boolean", "string", "number"].includes(typeof value),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, boolean | string | number | null>;
}

function assertStableHostEvidence(
  actual: HostEvidence,
  expected: HostEvidence,
): void {
  if (
    actual.agentVersion !== expected.agentVersion ||
    actual.cloudHypervisorSha256 !== expected.cloudHypervisorSha256 ||
    actual.capabilitiesFingerprint !== expected.capabilitiesFingerprint ||
    actual.desiredCachedImagesFingerprint !==
      expected.desiredCachedImagesFingerprint ||
    actual.actualCachedImagesFingerprint !==
      expected.actualCachedImagesFingerprint
  ) {
    throw new FatalIsolationError(
      "benchmark host execution identity, runtime hash, capabilities, or prewarm set changed between samples",
    );
  }
}

function assertStableHostResponse(
  host: HostResponse["host"],
  expected: HostEvidence,
): void {
  if (host.role !== "agent" || host.disabled) {
    throw new FatalIsolationError(
      "benchmark host role or enabled state changed during measurement",
    );
  }
  if (host.status.agentVersion !== expected.agentVersion) {
    throw new FatalIsolationError(
      `benchmark agent version changed from ${String(expected.agentVersion)} to ${String(host.status.agentVersion)}`,
    );
  }
  if (!host.actualState || !host.desiredState) {
    throw new FatalIsolationError(
      "benchmark host lost desired or actual state during measurement",
    );
  }
  const capabilities = normalizeCapabilities(host.actualState.capabilities);
  if (
    stableRecordFingerprint(capabilities) !==
      expected.capabilitiesFingerprint ||
    capabilities.cloud_hypervisor_sha256 !== expected.cloudHypervisorSha256
  ) {
    throw new FatalIsolationError(
      "benchmark host runtime hash or capability set changed during measurement",
    );
  }
  if (
    desiredCachedImagesFingerprint(host.desiredState.cachedImages) !==
    expected.desiredCachedImagesFingerprint
  ) {
    throw new FatalIsolationError(
      "benchmark host desired prewarm set changed during measurement",
    );
  }
  if (
    actualCachedImagesFingerprint(host.actualState.cachedImages) !==
    expected.actualCachedImagesFingerprint
  ) {
    throw new FatalIsolationError(
      "benchmark host actual prewarm readiness changed during measurement",
    );
  }
  if (
    host.desiredState.builds.length > 0 ||
    host.actualState.builds.length > 0
  ) {
    throw new FatalIsolationError(
      "build work appeared on the isolated benchmark host",
    );
  }
}

function stableRecordFingerprint(
  value: Record<string, boolean | string | number | null>,
): string {
  return JSON.stringify(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function desiredCachedImagesFingerprint(
  images: NonNullable<HostResponse["host"]["desiredState"]>["cachedImages"],
): string {
  return JSON.stringify(
    images
      .map((image) => ({
        scenario: image.image_key.scenario,
        vm: image.image_key.vm,
        arch: image.image_key.arch,
        sha256: image.image_sha256.toLowerCase(),
      }))
      .sort((left, right) =>
        `${left.scenario}/${left.vm}/${left.arch}/${left.sha256}`.localeCompare(
          `${right.scenario}/${right.vm}/${right.arch}/${right.sha256}`,
        ),
      ),
  );
}

function actualCachedImagesFingerprint(
  images: NonNullable<HostResponse["host"]["actualState"]>["cachedImages"],
): string {
  return JSON.stringify(
    images
      .map((image) => ({
        scenario: image.image_key.scenario,
        vm: image.image_key.vm,
        arch: image.image_key.arch,
        sha256: image.image_sha256.toLowerCase(),
        phase: image.phase,
        error: image.error ?? null,
      }))
      .sort((left, right) =>
        `${left.scenario}/${left.vm}/${left.arch}/${left.sha256}`.localeCompare(
          `${right.scenario}/${right.vm}/${right.arch}/${right.sha256}`,
        ),
      ),
  );
}

function benchmarkMarker(kind: "warmup" | "measured", ordinal: number): string {
  const random = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 16)
    .toUpperCase();
  return `INTAR_BOOT_${kind.toUpperCase()}_${ordinal}_${random}`;
}

async function writeBenchmarkResult(
  outputPath: string,
  result: BootBenchmarkResultV1,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error("boot measurement cancelled"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
      reject(new Error("boot measurement cancelled"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  console.log(`[boot-benchmark] ${message}`);
}

function printHelp(): void {
  console.log(`Usage:
  bun run bench:boot -- --base-url https://intar.dev \\
    --benchmark-token-file /secure/path/boot-benchmark.token \\
    --host HOST_ID --variant fully-optimized-current-path \\
    --manifest /path/broken-nginx.manifest.json \\
    --implementation-sha256 DEPLOYED_SHA256 --output optimized.json

Install Chromium first with: bun run bench:boot:install

Required:
  --host ID                         Pins every run to one performance-ready host.
  --variant NAME                    One of the five required comparison variants:
                                    ${BOOT_BENCHMARK_VARIANTS.join(", ")}.
                                    This breaking live runner executes only the
                                    two boot-lease variants; variants 1-3 must
                                    come from historical result artifacts.
  --manifest PATH                   Exact one-VM V3 manifest used for every boot.
  --implementation-sha256 SHA256    Required identity of the deployed
                                    control-plane/agent/jailerd implementation
                                    and rollout configuration.
  --base-url URL                    Defaults to INTAR_LIVE_BASE_URL.
  --benchmark-token-file PATH       Reads the dedicated production credential
                                    without placing it in argv. Alternatively
                                    set INTAR_BOOT_BENCH_TOKEN or
                                    INTAR_BOOT_BENCH_TOKEN_FILE.
                                    Token mode also requires
                                    INTAR_BOOT_BENCH_USER_ID and
                                    INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS.
  --cookie COOKIE                   Cookie-mode tooling alternative. Defaults
                                    to INTAR_BOOT_BENCH_COOKIE or
                                    INTAR_LIVE_COOKIE. It cannot run the
                                    fully-optimized promotion variant.

Promotion defaults:
  --warmups 5                       Warm boots discarded from percentiles.
  --samples 30                      Isolated measured boots.
  --poll-ms 100                     Matches the run UI's boot polling cadence.
  --wait-ready-ms 120000
  --wait-idle-ms 240000
  --terminal-probe-timeout-ms 15000

Evidence:
  --cloud-hypervisor-sha256 SHA256  Optionally cross-check the host attestation.
                                    Results always use the host-attested hash.
  --cold-prewarm-started-at-unix-ms MS
                                    Records cold prepare duration to the host's
                                    attested cached-image ready timestamp.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[boot-benchmark] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
