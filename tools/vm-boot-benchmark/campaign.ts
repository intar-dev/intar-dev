#!/usr/bin/env bun
/**
 * Run one VM boot benchmark campaign from a plan.
 *
 * The driver only orchestrates the tools that already exist. For every
 * planned sample it starts tools/vm-boot-benchmark/playwright-runner.ts,
 * collects host evidence through one trusted operator adapter, joins the
 * evidence with tools/vm-boot-benchmark.py, and destroys the run with
 * tools/vm-boot-benchmark/playwright-cleanup.ts.
 *
 * The driver does not create a VM, install a package, or change a host. A
 * host action is always the configured adapter program with one fixed verb
 * and validated arguments. The plan file is data: no command, path, or shell
 * text is ever taken from it.
 *
 * Host provisioning is not automated. The adapter is the operator's program,
 * and the driver records whether the host really attested its isolation or
 * whether that claim is only declared.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CAMPAIGN_KIND = "vm-boot-benchmark-campaign";
export const SCHEMA_VERSION = 2;
export const MAX_CONCURRENCY = 4;
export const UNSUPPORTED_EXIT_CODE = 3;
export const ACCEPTED_WAIT_MS = 60_000;
export const ACCEPTED_POLL_MS = 250;
export const HOST_ADAPTER_VERBS = [
  "attest",
  "pressure-capture",
  "cgroup-capture",
  "workload-events",
  "agent-events",
] as const;

const RUNNER_SCRIPT = "tools/vm-boot-benchmark/playwright-runner.ts";
const CLEANUP_SCRIPT = "tools/vm-boot-benchmark/playwright-cleanup.ts";
const TOOL_SCRIPT = "tools/vm-boot-benchmark.py";
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

export interface PlanSample {
  sample_id: string;
  scenario_id: string;
  condition: string;
  implementation: string;
  participant_id: string;
  expected_vm_count: number;
  launch_group: string;
  launch_concurrency: number;
  background_workload: string | null;
  release: { id: string; manifest_sha256: string };
}

export interface PlanGroup {
  id: string;
  condition: string;
  concurrency: number;
  samples: PlanSample[];
}

export interface CampaignOptions {
  plan: string;
  observations: string;
  evidenceDir: string;
  output: string;
  origin: string;
  startPage: string;
  participantStorageState: Map<string, string>;
  hostAdapter: string[];
  onlyGroup: string | null;
  runnerCommand: string[];
  cleanupCommand: string[];
  toolCommand: string[];
  timeoutMs: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StartedCommand {
  completion: Promise<CommandResult>;
}

export interface CampaignDeps {
  start(command: string[]): StartedCommand;
  run(command: string[]): Promise<CommandResult>;
  readJson(path: string): unknown;
  readText(path: string): string | null;
  writeJson(path: string, value: unknown): void;
  writeText(path: string, value: string): void;
  mkdir(path: string): void;
  exists(path: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface HostAttestation {
  verified: true;
  file: string;
  detail: string;
  differences: string[];
  hostname: string;
  hardware: string;
  cpu_cores: number;
  memory_mib: number;
  active_vms: number;
  environment: string;
  basis: string;
}

export interface SampleReport {
  sample_id: string;
  launch_group: string;
  scenario_id: string;
  condition: string;
  implementation: string;
  participant_id: string;
  status: "recorded" | "failed" | "skipped";
  run_id: string | null;
  failure_code: string | null;
  detail: string | null;
  teardown: "destroyed" | "failed" | "not-needed";
  evidence: Record<string, string>;
}

export interface GroupReport {
  launch_group: string;
  condition: string;
  concurrency: number;
  samples: number;
  started_unix_ms: number;
  finished_unix_ms: number;
}

export interface CampaignReport {
  schema_version: number;
  kind: string;
  plan_id: string;
  plan_sha256: string;
  observations: string;
  evidence_dir: string;
  host_adapter_command: string[] | null;
  host_isolation_id: string;
  host_attestation: HostAttestation;
  measurement: CampaignMeasurement;
  started_unix_ms: number;
  finished_unix_ms: number;
  groups: GroupReport[];
  samples: SampleReport[];
  skipped_sample_ids: string[];
  cleanup_failures: { sample_id: string; run_id: string; detail: string }[];
  aborted: { reason: string; sample_id: string | null; run_id: string | null } | null;
}

export interface CampaignMeasurement {
  host_attested: true;
  host_hostname: string;
  host_hardware: string;
  host_active_vms: number;
  background_workloads_proven: number;
  background_workloads_unproven: number;
  limits: string[];
}

export const MEASUREMENT_LIMITS = [
  "The archive half of cache-refresh+archive is not separately observable: this agent release" +
    " logs its refresh pass and its incremental scrub, and no archive step.",
  "The declared background workload rate is an operator input; the driver proves host events" +
    " inside each sample window, not the rate.",
  "The host attestation proves what the host reported and what the run manifest declared." +
    " Neither the driver nor the tool can detect a host that lies.",
  "This page is not a rollout harness: no restart, rollback, or host change is automated.",
];

export class CampaignError extends Error {}

function usage() {
  return [
    "Usage:",
    "  bun tools/vm-boot-benchmark/campaign.ts \\",
    "    --plan <plan.json> \\",
    "    --observations <observations.ndjson> \\",
    "    --evidence-dir <directory> \\",
    "    --output <campaign-report.json> \\",
    "    --origin <https://selected-environment-origin> \\",
    "    --start-page </same-origin-learner-lecture-path> \\",
    "    --participant-storage-state <participant>=<playwright-storage-state.json> \\",
    "    --host-adapter <trusted-operator-program> [--host-adapter-arg <argument>] \\",
    "    [--group <launch-group-id>] \\",
    "    [--runner <program>] [--cleanup <program>] [--tool <program>] \\",
    "    [--timeout-ms <milliseconds>]",
    "",
    "The host adapter is one trusted operator program that the driver calls with",
    "fixed verbs: " + HOST_ADAPTER_VERBS.join(", ") + ". Each verb receives validated",
    "arguments and an --output path inside --evidence-dir. Exit code " +
      UNSUPPORTED_EXIT_CODE + " means the verb is not supported.",
    "",
    "Without --host-adapter the campaign cannot collect host evidence and stops",
    "before the first sample.",
    "",
    "A live campaign always needs a verified host attestation. There is no",
    "bypass flag: a host adapter that cannot attest stops the campaign before",
    "the first sample, and the plan itself cannot exist without an attested",
    "isolated host.",
  ].join("\n");
}

export function parseCampaignArguments(argv: string[]): CampaignOptions {
  const values = new Map<string, string[]>();
  const known = new Set([
    "plan",
    "observations",
    "evidence-dir",
    "output",
    "origin",
    "start-page",
    "participant-storage-state",
    "host-adapter",
    "host-adapter-arg",
    "runner",
    "runner-arg",
    "cleanup",
    "cleanup-arg",
    "tool",
    "tool-arg",
    "timeout-ms",
    "group",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      throw new CampaignError("unexpected argument: " + argument);
    }
    const equalsAt = argument.indexOf("=");
    const key = argument.slice(2, equalsAt === -1 ? undefined : equalsAt);
    if (!known.has(key)) throw new CampaignError("unknown option: --" + key);
    const value = equalsAt === -1 ? argv[++index] : argument.slice(equalsAt + 1);
    if (!value || value.startsWith("--")) {
      throw new CampaignError("option requires a value: --" + key);
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  const required = (key: string) => {
    const entry = values.get(key)?.[0]?.trim();
    if (!entry) throw new CampaignError("missing required option: --" + key);
    return entry;
  };
  const timeoutMs = Number(values.get("timeout-ms")?.[0] ?? 900_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new CampaignError("--timeout-ms must be an integer of at least 1000");
  }

  const participantStorageState = new Map<string, string>();
  for (const entry of values.get("participant-storage-state") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new CampaignError("--participant-storage-state must use <participant>=<path>");
    }
    const participant = entry.slice(0, separator).trim();
    const path = entry.slice(separator + 1).trim();
    if (!SAFE_IDENTIFIER.test(participant) || !path) {
      throw new CampaignError("--participant-storage-state has an invalid participant or path");
    }
    if (participantStorageState.has(participant)) {
      throw new CampaignError("--participant-storage-state repeats a participant: " + participant);
    }
    participantStorageState.set(participant, resolve(path));
  }
  if (participantStorageState.size === 0) {
    throw new CampaignError("at least one --participant-storage-state is required");
  }

  const group = values.get("group")?.[0]?.trim() ?? null;
  if (group !== null && !SAFE_IDENTIFIER.test(group)) {
    throw new CampaignError("--group has an invalid format");
  }

  return {
    plan: resolve(required("plan")),
    observations: resolve(required("observations")),
    evidenceDir: resolve(required("evidence-dir")),
    output: resolve(required("output")),
    origin: normalizeOrigin(required("origin")),
    startPage: required("start-page"),
    participantStorageState,
    hostAdapter: [
      ...(values.get("host-adapter") ?? []),
      ...(values.get("host-adapter-arg") ?? []),
    ],
    onlyGroup: group,
    runnerCommand: [
      ...(values.get("runner") ?? ["bun"]),
      RUNNER_SCRIPT,
      ...(values.get("runner-arg") ?? []),
    ],
    cleanupCommand: [
      ...(values.get("cleanup") ?? ["bun"]),
      CLEANUP_SCRIPT,
      ...(values.get("cleanup-arg") ?? []),
    ],
    toolCommand: [
      ...(values.get("tool") ?? ["python3"]),
      TOOL_SCRIPT,
      ...(values.get("tool-arg") ?? []),
    ],
    timeoutMs,
  };
}

function normalizeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CampaignError("--origin must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new CampaignError("--origin must be a plain HTTP(S) origin");
  }
  return url.origin;
}

function requireIdentifier(value: unknown, name: string) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new CampaignError(name + " has an invalid format");
  }
  return value;
}

export function planGroups(plan: {
  schedule: PlanSample[];
  conditions: string[];
}): PlanGroup[] {
  if (!Array.isArray(plan.schedule) || plan.schedule.length === 0) {
    throw new CampaignError("plan has no schedule");
  }
  if (!Array.isArray(plan.conditions) || plan.conditions.length === 0) {
    throw new CampaignError("plan has no conditions");
  }
  const groups = new Map<string, PlanGroup>();
  for (const sample of plan.schedule) {
    const id = requireIdentifier(sample.launch_group, "plan launch group");
    const concurrency = Number(sample.launch_concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      throw new CampaignError("plan launch concurrency must be between 1 and " + MAX_CONCURRENCY);
    }
    if (!plan.conditions.includes(sample.condition)) {
      throw new CampaignError("plan sample condition is not in the plan: " + sample.condition);
    }
    const group = groups.get(id) ?? { id, condition: sample.condition, concurrency, samples: [] };
    if (group.condition !== sample.condition || group.concurrency !== concurrency) {
      throw new CampaignError("plan launch group mixes conditions or concurrency: " + id);
    }
    if (group.samples.some((entry) => entry.participant_id === sample.participant_id)) {
      throw new CampaignError("plan launch group reuses a participant: " + id);
    }
    group.samples.push(sample);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function failureCodeFor(value: string) {
  if (!SAFE_FAILURE_CODE.test(value)) {
    throw new CampaignError("failure code has an invalid format: " + value);
  }
  return value;
}

export function evidencePaths(evidenceDir: string, sample: PlanSample) {
  const stem = evidenceStem(sample.sample_id);
  return {
    accepted: resolve(evidenceDir, stem + "-accepted.json"),
    browser: resolve(evidenceDir, stem + "-browser.json"),
    cgroupBefore: resolve(evidenceDir, stem + "-host-before.json"),
    cgroupAfter: resolve(evidenceDir, stem + "-host-after.json"),
    hostDelta: resolve(evidenceDir, stem + "-host-delta.json"),
    agentEvents: resolve(evidenceDir, stem + "-agent-events.ndjson"),
    runnerLog: resolve(evidenceDir, stem + "-runner.log"),
  };
}

/**
 * Keep one evidence file name per sample and inside the evidence directory.
 *
 * A plan sample ID is data. It may contain characters that a file system
 * treats specially, so the file name is derived from it and never used as a
 * path.
 */
export function evidenceStem(sampleId: string) {
  const safe = sampleId.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (safe === sampleId && safe.length <= 120) return safe;
  const digest = createHash("sha256").update(sampleId).digest("hex").slice(0, 8);
  return (safe.length > 120 ? safe.slice(0, 120) : safe) + "-" + digest;
}

export function groupPressurePaths(evidenceDir: string, group: PlanGroup) {
  return {
    before: resolve(evidenceDir, group.id + "-pressure-before.json"),
    after: resolve(evidenceDir, group.id + "-pressure-after.json"),
  };
}

export function defaultDeps(): CampaignDeps {
  const start = (command: string[]): StartedCommand => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    const completion = new Promise<CommandResult>((resolvePromise) => {
      child.on("error", (error: unknown) => {
        resolvePromise({ code: 127, stdout, stderr: stderr + String(error) });
      });
      child.on("close", (code: number | null) => {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
    return { completion };
  };
  return {
    start,
    run: (command) => start(command).completion,
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    writeJson: (path, value) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    },
    writeText: (path, value) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value, { mode: 0o600 });
    },
    mkdir: (path) => {
      mkdirSync(path, { recursive: true });
    },
    exists: (path) => existsSync(path),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
  };
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CampaignError(name + " must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CampaignError(name + " must be a nonempty string");
  }
  return value;
}

export interface RecordedObservations {
  skippable: Set<string>;
  leaked: { sample_id: string; run_id: string | null }[];
}

/**
 * Read the observations file to decide what a resumed campaign may skip.
 *
 * A sample is skippable only when its run really finished teardown. A sample
 * whose teardown failed is a leaked run on the host, and skipping it would
 * hide that run behind a resumed campaign, so the driver refuses to start.
 */
export function recordedObservations(content: string | null): RecordedObservations {
  const skippable = new Set<string>();
  const leaked: { sample_id: string; run_id: string | null }[] = [];
  for (const line of (content ?? "").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CampaignError("the observations file has a line that is not valid JSON");
    }
    const record = requireObject(parsed, "observation line");
    const sampleId = requireString(record.sample_id, "observation sample ID");
    if (record.teardown === "destroyed" || record.teardown === "not-needed") {
      skippable.add(sampleId);
      continue;
    }
    leaked.push({
      sample_id: sampleId,
      run_id: typeof record.runtime_run_id === "string" ? record.runtime_run_id : null,
    });
  }
  return { skippable, leaked };
}

export function hostAdapterCommand(
  options: CampaignOptions,
  verb: string,
  args: string[],
  output: string,
) {
  if (!(HOST_ADAPTER_VERBS as readonly string[]).includes(verb)) {
    throw new CampaignError("unknown host adapter verb: " + verb);
  }
  return [...options.hostAdapter, verb, ...args, "--output", output];
}

export function requireHostAdapter(options: CampaignOptions) {
  if (options.hostAdapter.length === 0) {
    throw new CampaignError(
      "this campaign needs --host-adapter. No tool here can read a remote host," +
        " so host evidence must come from one trusted operator program with the" +
        " verbs: " +
        HOST_ADAPTER_VERBS.join(", ") +
        ". Exit code " +
        UNSUPPORTED_EXIT_CODE +
        " means a verb is not supported.",
    );
  }
  return options.hostAdapter;
}

export async function attestHost(
  options: CampaignOptions,
  host: Record<string, unknown>,
  deps: CampaignDeps,
): Promise<HostAttestation> {
  requireHostAdapter(options);
  const file = resolve(options.evidenceDir, "host-attestation.json");
  const result = await deps.run(hostAdapterCommand(options, "attest", [], file));
  if (result.code === UNSUPPORTED_EXIT_CODE) {
    throw new CampaignError(
      "the host adapter cannot attest the isolated host (exit code " +
        UNSUPPORTED_EXIT_CODE +
        "). A live campaign always needs a verified host attestation, and there is no bypass flag.",
    );
  }
  if (result.code !== 0) {
    throw new CampaignError(
      "the host adapter attest failed with exit code " + result.code + ": " + result.stderr.trim(),
    );
  }
  const attestation = requireObject(deps.readJson(file), "host attestation");
  if (attestation.verified !== true) {
    throw new CampaignError("the host attestation is not verified");
  }
  if (attestation.environment !== "benchmark") {
    throw new CampaignError("the host attestation environment is not benchmark");
  }
  if (attestation.production !== false) {
    throw new CampaignError("the host attestation did not state production=false");
  }
  const activeVms = Number(attestation.active_vms);
  if (!Number.isSafeInteger(activeVms) || activeVms !== 0) {
    throw new CampaignError("the host attestation reports active VMs; the benchmark host is not empty");
  }
  const differences: string[] = [];
  for (const field of ["isolation_id", "controller", "controller_lease_id", "cpu_class", "region"]) {
    if (attestation[field] !== host[field]) {
      differences.push(
        field + ": manifest " + String(host[field]) + ", host " + String(attestation[field]),
      );
    }
  }
  return {
    verified: true,
    file,
    detail:
      "the host attested isolation " + String(attestation.isolation_id) + " with production=false",
    differences,
    hostname: requireString(attestation.hostname, "host attestation hostname"),
    hardware: requireString(attestation.hardware, "host attestation hardware"),
    cpu_cores: Number(attestation.cpu_cores),
    memory_mib: Number(attestation.memory_mib),
    active_vms: activeVms,
    environment: String(attestation.environment),
    basis: requireString(attestation.basis, "host attestation basis"),
  };
}

interface SampleRun {
  sample: PlanSample;
  paths: ReturnType<typeof evidencePaths>;
  started: StartedCommand | null;
  runId: string | null;
  runner: CommandResult | null;
  failureCode: string | null;
  detail: string | null;
}

function runnerArguments(
  options: CampaignOptions,
  sample: PlanSample,
  paths: ReturnType<typeof evidencePaths>,
) {
  return [
    ...options.runnerCommand,
    "--origin",
    options.origin,
    "--storage-state",
    options.participantStorageState.get(sample.participant_id) ?? "",
    "--start-page",
    options.startPage,
    "--scenario-id",
    sample.scenario_id,
    "--variant",
    sample.implementation,
    "--release-id",
    sample.release.id,
    "--release-manifest-sha256",
    sample.release.manifest_sha256,
    "--participant-id",
    sample.participant_id,
    "--run-id",
    sample.sample_id,
    "--on-run-accepted-output",
    paths.accepted,
    "--output",
    paths.browser,
    "--timeout-ms",
    String(options.timeoutMs),
  ];
}

async function waitForAccepted(run: SampleRun, deps: CampaignDeps) {
  const deadline = deps.now() + ACCEPTED_WAIT_MS;
  while (deps.now() < deadline) {
    if (deps.exists(run.paths.accepted)) {
      const runId = requireString(
        requireObject(deps.readJson(run.paths.accepted), "accepted run").runId,
        "accepted run ID",
      );
      if (!SAFE_IDENTIFIER.test(runId)) {
        throw new CampaignError("the accepted run ID has an invalid format");
      }
      return runId;
    }
    await deps.sleep(ACCEPTED_POLL_MS);
  }
  return null;
}

interface AdapterOutcome {
  ok: boolean;
  detail: string;
}

async function callAdapter(
  options: CampaignOptions,
  deps: CampaignDeps,
  verb: string,
  args: string[],
  output: string,
): Promise<AdapterOutcome> {
  const result = await deps.run(hostAdapterCommand(options, verb, args, output));
  if (result.code === UNSUPPORTED_EXIT_CODE) {
    return { ok: false, detail: verb + " is not supported by the host adapter" };
  }
  if (result.code !== 0) {
    return { ok: false, detail: verb + " failed with exit code " + result.code };
  }
  return { ok: true, detail: verb + " finished" };
}

async function capturePressure(
  options: CampaignOptions,
  deps: CampaignDeps,
  group: PlanGroup,
  which: "before" | "after",
) {
  const paths = groupPressurePaths(options.evidenceDir, group);
  const file = which === "before" ? paths.before : paths.after;
  const outcome = await callAdapter(options, deps, "pressure-capture", [], file);
  return outcome.ok ? file : null;
}

/**
 * Read the host workload events for one batch window.

 * The window comes from the two host pressure snapshots, so it uses the host
 * clock and contains every sample window of the batch. The tool then proves
 * that a real host event falls inside each background sample window.
 */
async function captureWorkloadEvents(
  options: CampaignOptions,
  deps: CampaignDeps,
  file: string,
  windowStart: number,
  windowEnd: number,
) {
  return callAdapter(
    options,
    deps,
    "workload-events",
    ["--start-unix-ms", String(windowStart), "--end-unix-ms", String(windowEnd)],
    file,
  );
}

async function hostSnapshotTime(
  options: CampaignOptions,
  deps: CampaignDeps,
  file: string | null,
): Promise<number | null> {
  if (file === null) return null;
  try {
    const snapshot = requireObject(deps.readJson(file), "host pressure snapshot");
    const captured = Number(snapshot.captured_unix_ms);
    return Number.isSafeInteger(captured) && captured > 0 ? captured : null;
  } catch {
    return null;
  }
}

async function executeBatch(
  options: CampaignOptions,
  deps: CampaignDeps,
  runs: SampleRun[],
) {
  for (const run of runs) {
    run.started = deps.start(runnerArguments(options, run.sample, run.paths));
  }
  for (const run of runs) {
    run.runId = await waitForAccepted(run, deps);
  }
  for (const run of runs) {
    if (run.runId === null) continue;
    const outcome = await callAdapter(
      options,
      deps,
      "cgroup-capture",
      [
        "--run-id",
        run.runId,
        "--expected-vm-count",
        String(Number(run.sample.expected_vm_count)),
        "--wait-seconds",
        "60",
      ],
      run.paths.cgroupBefore,
    );
    if (!outcome.ok) {
      run.failureCode = failureCodeFor("host_capture_failed");
      run.detail = outcome.detail;
    }
  }
  for (const run of runs) {
    const started = run.started;
    run.started = null;
    const result = await started!.completion;
    run.runner = result;
    deps.writeText(
      run.paths.runnerLog,
      "exit=" + result.code + "\n" + result.stdout + result.stderr,
    );
    if (result.code !== 0 && run.failureCode === null) {
      run.failureCode = failureCodeFor(run.runId === null ? "start_failed" : "terminal_failed");
      run.detail = "the browser runner failed with exit code " + result.code;
    }
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function backgroundWorkloadId(plan: Record<string, unknown>, run: SampleRun) {
  const workloads = requireObject(plan.background_workloads, "plan background workloads");
  const key = run.sample.background_workload ?? "";
  return requireString(
    requireObject(workloads[key], "plan background workload " + key).workload_id,
    "plan background workload ID",
  );
}

function recordArguments(
  plan: Record<string, unknown>,
  options: CampaignOptions,
  run: SampleRun,
) {
  const args = [
    "record",
    "--plan",
    options.plan,
    "--sample-id",
    run.sample.sample_id,
    "--participant-id",
    run.sample.participant_id,
    "--output",
    options.observations,
  ];
  if (run.sample.background_workload !== null) {
    args.push("--cache-refresh-id", backgroundWorkloadId(plan, run));
  }
  return args;
}

interface PreparedSample {
  run: SampleRun;
  failureCode: string | null;
  detail: string | null;
  clientRttMs: number | null;
  evidence: Record<string, string>;
  abort: string | null;
}

/**
 * Measure one sample while its run is still live.
 *
 * Every host capture and the browser evidence are read here, before teardown,
 * so the measured numbers belong to the run and not to a host that is being
 * destroyed. Nothing is written to the observations yet: the teardown outcome
 * is part of the same observation.
 */
async function captureSample(
  options: CampaignOptions,
  deps: CampaignDeps,
  run: SampleRun,
  pressureBefore: string | null,
  pressureAfter: string | null,
  workloadEvents: string | null,
): Promise<PreparedSample> {
  const prepared: PreparedSample = {
    run,
    failureCode: null,
    detail: run.detail,
    clientRttMs: null,
    evidence: {},
    abort: null,
  };
  const failWith = (code: string, detail: string | null) => {
    prepared.failureCode = run.failureCode ?? failureCodeFor(code);
    prepared.detail = detail ?? prepared.detail;
    return prepared;
  };
  if (run.runId === null || run.failureCode !== null) {
    return failWith("start_failed", run.detail);
  }
  if (pressureBefore === null || pressureAfter === null) {
    return failWith("host_capture_failed", "the host pressure snapshots are missing");
  }
  if (run.sample.background_workload !== null && workloadEvents === null) {
    return failWith(
      "background_workload_not_observed",
      "the host adapter did not return the background workload events",
    );
  }
  const lateCaptures: [string, string[], string][] = [
    [
      "cgroup-capture",
      [
        "--run-id",
        run.runId,
        "--expected-vm-count",
        String(Number(run.sample.expected_vm_count)),
        "--wait-seconds",
        "0",
      ],
      run.paths.cgroupAfter,
    ],
    ["agent-events", ["--run-id", run.runId], run.paths.agentEvents],
  ];
  for (const [verb, args, output] of lateCaptures) {
    const outcome = await callAdapter(options, deps, verb, args, output);
    if (!outcome.ok) {
      return failWith("host_capture_failed", outcome.detail);
    }
  }
  const delta = await deps.run([
    ...options.toolCommand,
    "host-delta",
    "--before",
    run.paths.cgroupBefore,
    "--after",
    run.paths.cgroupAfter,
    "--host-pressure-before",
    pressureBefore,
    "--host-pressure-after",
    pressureAfter,
    "--output",
    run.paths.hostDelta,
  ]);
  if (delta.code !== 0) {
    return failWith("host_capture_failed", "the host delta command failed: " + delta.stderr.trim());
  }
  const browser = requireObject(deps.readJson(run.paths.browser), "browser evidence");
  const clientRttMs = browser.clientRttMs;
  if (!Number.isSafeInteger(clientRttMs) || (clientRttMs as number) < 1) {
    prepared.abort =
      "the browser evidence of " + run.sample.sample_id + " has no measured client RTT";
    return prepared;
  }
  prepared.clientRttMs = clientRttMs as number;
  prepared.evidence = {
    browser: run.paths.browser,
    agent_events: run.paths.agentEvents,
    host_before: run.paths.cgroupBefore,
    host_after: run.paths.cgroupAfter,
    host_delta: run.paths.hostDelta,
    pressure_before: pressureBefore,
    pressure_after: pressureAfter,
  };
  return prepared;
}

async function teardownRun(
  options: CampaignOptions,
  deps: CampaignDeps,
  run: SampleRun,
  report: CampaignReport,
): Promise<"destroyed" | "failed" | "not-needed"> {
  if (run.runId === null) return "not-needed";
  const result = await deps.run([
    ...options.cleanupCommand,
    "--origin",
    options.origin,
    "--storage-state",
    options.participantStorageState.get(run.sample.participant_id) ?? "",
    "--run-id",
    run.runId,
    "--timeout-ms",
    String(options.timeoutMs),
  ]);
  if (result.code === 0) {
    try {
      const parsed = requireObject(JSON.parse(result.stdout.trim()), "cleanup result");
      if (parsed.state === "absent" || parsed.state === "terminal") {
        return "destroyed";
      }
    } catch {
      // A cleanup result that cannot be read counts as a cleanup failure.
    }
  }
  report.cleanup_failures.push({
    sample_id: run.sample.sample_id,
    run_id: run.runId,
    detail: result.stderr.trim() || "the cleanup command did not confirm teardown",
  });
  return "failed";
}

/**
 * Write one observation after the teardown outcome is known.
 *
 * The record command runs with the real teardown state, so a run that did not
 * finish teardown is recorded, kept in the report, and rejected by the gate.
 */
async function writeSampleRecord(
  plan: Record<string, unknown>,
  options: CampaignOptions,
  deps: CampaignDeps,
  prepared: PreparedSample,
  teardown: "destroyed" | "failed" | "not-needed",
): Promise<{ entry: SampleReport; abort: string | null }> {
  const run = prepared.run;
  const entry: SampleReport = {
    sample_id: run.sample.sample_id,
    launch_group: run.sample.launch_group,
    scenario_id: run.sample.scenario_id,
    condition: run.sample.condition,
    implementation: run.sample.implementation,
    participant_id: run.sample.participant_id,
    status: "failed",
    run_id: run.runId,
    failure_code: null,
    detail: prepared.detail,
    teardown,
    evidence: prepared.evidence,
  };
  const common = [
    ...options.toolCommand,
    ...recordArguments(plan, options, run),
    "--teardown",
    teardown,
  ];
  if (prepared.failureCode !== null) {
    entry.failure_code = prepared.failureCode;
    const result = await deps.run([
      ...common,
      "--status",
      "failure",
      "--failure-code",
      prepared.failureCode,
    ]);
    if (result.code !== 0) {
      entry.detail = "the record command failed: " + result.stderr.trim();
      return { entry, abort: "the record command failed for " + run.sample.sample_id };
    }
    entry.status = "failed";
    return { entry, abort: null };
  }
  if (prepared.abort !== null) {
    return { entry, abort: prepared.abort };
  }
  const result = await deps.run([
    ...common,
    "--client-rtt-ms",
    String(prepared.clientRttMs),
    "--status",
    "success",
    "--run-id",
    run.runId ?? "",
    "--browser-evidence",
    run.paths.browser,
    "--agent-events",
    run.paths.agentEvents,
    "--host-delta",
    run.paths.hostDelta,
    ...(plan.background_workloads && run.sample.background_workload !== null
      ? [
          "--workload-events",
          resolve(options.evidenceDir, run.sample.launch_group + "-workload-events.json"),
        ]
      : []),
  ]);
  if (result.code !== 0) {
    entry.detail = "the record command failed: " + result.stderr.trim();
    return { entry, abort: "the record command failed for " + run.sample.sample_id };
  }
  entry.status = "recorded";
  return { entry, abort: null };
}
export async function runCampaign(
  options: CampaignOptions,
  deps: CampaignDeps = defaultDeps(),
): Promise<CampaignReport> {
  const plan = requireObject(deps.readJson(options.plan), "plan");
  if (plan.schema_version !== SCHEMA_VERSION) {
    throw new CampaignError("plan has an unsupported schema version");
  }
  const planId = requireIdentifier(plan.plan_id, "plan ID");
  const planSha256 = requireString(plan.plan_sha256, "plan SHA-256");
  if (!/^[0-9a-f]{64}$/u.test(planSha256)) {
    throw new CampaignError("plan SHA-256 has an invalid format");
  }
  const host = requireObject(plan.host, "plan host");
  const groups = planGroups(plan as never);
  requireHostAdapter(options);
  deps.mkdir(options.evidenceDir);

  for (const group of groups) {
    for (const sample of group.samples) {
      requireIdentifier(sample.sample_id, "plan sample ID");
      requireIdentifier(sample.scenario_id, "plan scenario ID");
      requireIdentifier(sample.condition, "plan condition");
      requireIdentifier(sample.participant_id, "plan participant ID");
      if (sample.implementation !== "baseline" && sample.implementation !== "candidate") {
        throw new CampaignError("plan sample implementation must be baseline or candidate");
      }
      const release = requireObject(sample.release, "plan sample release");
      requireIdentifier(release.id, "plan release ID");
      const manifestSha256 = requireString(release.manifest_sha256, "plan release manifest SHA-256");
      if (!/^[0-9a-f]{64}$/u.test(manifestSha256)) {
        throw new CampaignError("plan release manifest SHA-256 has an invalid format");
      }
      if (
        sample.background_workload !== null &&
        typeof sample.background_workload !== "string"
      ) {
        throw new CampaignError("plan sample background workload must be a string or null");
      }
      const expected = Number(sample.expected_vm_count);
      if (!Number.isSafeInteger(expected) || expected < 1) {
        throw new CampaignError("plan expected VM count must be at least 1");
      }
      const storageState = options.participantStorageState.get(sample.participant_id);
      if (!storageState) {
        throw new CampaignError(
          "the plan uses participant " +
            sample.participant_id +
            " and no --participant-storage-state was given for it",
        );
      }
      if (!deps.exists(storageState)) {
        throw new CampaignError("the storage state file is missing for " + sample.participant_id);
      }
    }
  }

  const attestation = await attestHost(options, host, deps);
  if (attestation.differences.length > 0) {
    throw new CampaignError(
      "the host attestation does not match the run manifest: " + attestation.differences.join("; "),
    );
  }
  const plannedAttestation = requireObject(plan.host_attestation, "plan host attestation");
  for (const field of ["hostname", "hardware", "cpu_cores", "memory_mib"]) {
    if (plannedAttestation[field] !== attestation[field as keyof HostAttestation]) {
      throw new CampaignError(
        "the host does not match the attestation recorded in the plan: " +
          field +
          " (" +
          String(attestation[field as keyof HostAttestation]) +
          " against " +
          String(plannedAttestation[field]) +
          ")",
      );
    }
  }

  const planned =
    options.onlyGroup === null
      ? groups
      : groups.filter((group) => group.id === options.onlyGroup);
  if (options.onlyGroup !== null && planned.length === 0) {
    throw new CampaignError("the requested launch group is not in the plan: " + options.onlyGroup);
  }

  const recorded = recordedObservations(deps.readText(options.observations));
  if (recorded.leaked.length > 0) {
    const first = recorded.leaked[0]!;
    throw new CampaignError(
      "the observations file has " +
        recorded.leaked.length +
        " sample(s) whose run did not finish teardown. Destroy them on the host before a" +
        " resumed campaign, starting with " +
        first.sample_id +
        (first.run_id === null ? "" : " (run " + first.run_id + ")") +
        ".",
    );
  }
  const started = deps.now();
  const report: CampaignReport = {
    schema_version: SCHEMA_VERSION,
    kind: CAMPAIGN_KIND,
    plan_id: planId,
    plan_sha256: planSha256,
    observations: options.observations,
    evidence_dir: options.evidenceDir,
    host_adapter_command: options.hostAdapter,
    host_isolation_id: String(host.isolation_id),
    host_attestation: attestation,
    measurement: {
      host_attested: true,
      host_hostname: attestation.hostname,
      host_hardware: attestation.hardware,
      host_active_vms: attestation.active_vms,
      background_workloads_proven: 0,
      background_workloads_unproven: 0,
      limits: [...MEASUREMENT_LIMITS],
    },
    started_unix_ms: started,
    finished_unix_ms: started,
    groups: [],
    samples: [],
    skipped_sample_ids: [],
    cleanup_failures: [],
    aborted: null,
  };
  const commit = () => {
    report.finished_unix_ms = deps.now();
    deps.writeJson(options.output, report);
  };
  commit();

  for (const group of planned) {
    const pending: SampleRun[] = [];
    for (const sample of group.samples) {
      if (recorded.skippable.has(sample.sample_id)) {
        report.skipped_sample_ids.push(sample.sample_id);
        report.samples.push({
          sample_id: sample.sample_id,
          launch_group: group.id,
          scenario_id: sample.scenario_id,
          condition: sample.condition,
          implementation: sample.implementation,
          participant_id: sample.participant_id,
          status: "skipped",
          run_id: null,
          failure_code: null,
          detail: "the observations file already has this sample",
          teardown: "not-needed",
          evidence: {},
        });
        continue;
      }
      pending.push({
        sample,
        paths: evidencePaths(options.evidenceDir, sample),
        started: null,
        runId: null,
        runner: null,
        failureCode: null,
        detail: null,
      });
    }
    if (pending.length === 0) continue;

    const groupReport: GroupReport = {
      launch_group: group.id,
      condition: group.condition,
      concurrency: group.concurrency,
      samples: pending.length,
      started_unix_ms: deps.now(),
      finished_unix_ms: deps.now(),
    };
    report.groups.push(groupReport);
    process.stderr.write(
      "[campaign] " + group.id + " " + group.condition + " x" + group.concurrency + "\n",
    );

    // One batch is one pressure window. A serial group is a batch of one, so
    // its pressure window is per sample; a concurrent group shares one window
    // because its VMs overlap in time.
    for (const batch of chunks(pending, group.concurrency)) {
      const pressureBefore = await capturePressure(options, deps, group, "before");
      await executeBatch(options, deps, batch);
      const pressureAfter = await capturePressure(options, deps, group, "after");
      let workloadEvents: string | null = null;
      if (batch.some((run) => run.sample.background_workload !== null)) {
        const start = await hostSnapshotTime(options, deps, pressureBefore);
        const end = await hostSnapshotTime(options, deps, pressureAfter);
        if (start === null || end === null) {
          report.aborted = {
            reason:
              "the host pressure snapshots have no host time, so the background workload" +
              " cannot be proven",
            sample_id: batch[0]!.sample.sample_id,
            run_id: batch[0]!.runId,
          };
          commit();
          break;
        }
        const file = resolve(options.evidenceDir, group.id + "-workload-events.json");
        const outcome = await captureWorkloadEvents(options, deps, file, start, end);
        workloadEvents = outcome.ok ? file : null;
      }
      // Measure first, tear down second, record third. The record command
      // carries the real teardown outcome, so a leaked run cannot disappear
      // behind a passing sample.
      const prepared: PreparedSample[] = [];
      for (const run of batch) {
        prepared.push(
          await captureSample(options, deps, run, pressureBefore, pressureAfter, workloadEvents),
        );
      }
      const teardowns = new Map<SampleRun, "destroyed" | "failed" | "not-needed">();
      for (const run of batch) {
        teardowns.set(run, await teardownRun(options, deps, run, report));
      }
      for (const item of prepared) {
        const outcome = await writeSampleRecord(
          plan,
          options,
          deps,
          item,
          teardowns.get(item.run) ?? "failed",
        );
        report.samples.push(outcome.entry);
        if (item.run.sample.background_workload !== null) {
          if (outcome.entry.status === "recorded") {
            report.measurement.background_workloads_proven += 1;
          } else {
            report.measurement.background_workloads_unproven += 1;
          }
        }
        if (outcome.abort !== null) {
          report.aborted = {
            reason: outcome.abort,
            sample_id: item.run.sample.sample_id,
            run_id: item.run.runId,
          };
          break;
        }
      }
      // A teardown failure stops the group; the single post-group block below
      // turns it into one abort record, so the reason is written once.
      if (report.aborted !== null || report.cleanup_failures.length > 0) break;
    }

    groupReport.finished_unix_ms = deps.now();
    commit();
    if (report.aborted !== null) break;
    if (report.cleanup_failures.length > 0) {
      const last = report.cleanup_failures[report.cleanup_failures.length - 1]!;
      report.aborted = {
        reason: "a run did not finish teardown, so the next group cannot start",
        sample_id: last.sample_id,
        run_id: last.run_id,
      };
      commit();
      break;
    }
  }

  commit();
  return report;
}

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(usage() + "\n");
    return;
  }
  const options = parseCampaignArguments(argv);
  const report = await runCampaign(options);
  const recorded = report.samples.filter((sample) => sample.status === "recorded").length;
  const failed = report.samples.filter((sample) => sample.status === "failed").length;
  process.stdout.write(
    JSON.stringify({
      kind: report.kind,
      plan_id: report.plan_id,
      groups: report.groups.length,
      recorded,
      failed,
      skipped: report.skipped_sample_ids.length,
      cleanup_failures: report.cleanup_failures.length,
      aborted: report.aborted,
      output: options.output,
    }) + "\n",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "campaign failed";
    process.stderr.write("campaign failed: " + message + "\n");
    process.exitCode = 1;
  });
}
