import { describe, expect, test } from "bun:test";
import {
  ACCEPTED_WAIT_MS,
  CampaignError,
  HOST_ADAPTER_VERBS,
  UNSUPPORTED_EXIT_CODE,
  parseCampaignArguments,
  planGroups,
  requireHostAdapter,
  runCampaign,
  type CampaignDeps,
  type CommandResult,
  type PlanSample,
  type StartedCommand,
} from "./campaign";

const ORIGIN = "https://intar.example";
const START_PAGE = "/courses/fundamentals/lectures/broken-nginx";
const PARTICIPANTS = ["bench-a", "bench-b", "bench-c", "bench-d"];

function sample(overrides: Partial<PlanSample> & { sample_id: string }): PlanSample {
  return {
    scenario_id: "broken-nginx",
    condition: "concurrent-4-prepared",
    implementation: "candidate",
    participant_id: PARTICIPANTS[0]!,
    expected_vm_count: 1,
    launch_group: "group-0001",
    launch_concurrency: 4,
    background_workload: null,
    release: { id: "candidate-release", manifest_sha256: "b".repeat(64) },
    ...overrides,
  };
}

function concurrentPlan() {
  return {
    schema_version: 2,
    plan_id: "plan-1",
    plan_sha256: "a".repeat(64),
    host: {
      controller: "intar-host-controller",
      controller_lease_id: "lease-0123",
      isolation_id: "bench-eu-1",
      production: false,
      cpu_class: "prod-24-vcpu",
      region: "eu-west",
    },
    host_attestation: {
      sha256: "c".repeat(64),
      hostname: "bench-eu-1.intar.test",
      hardware: "AMD EPYC 9354",
      cpu_cores: 24,
      memory_mib: 98304,
      active_vms: 0,
      environment: "benchmark",
      basis: "root-provisioned attestation file read over SSH",
      captured_unix_ms: 1_757_699_000_000,
    },
    conditions: [
      "serial-prepared",
      "concurrent-4-prepared",
      "serial-background-cache",
      "concurrent-4-background-cache-archive",
    ],
    background_workloads: {
      "cache-refresh": { workload_id: "cache-refresh-77", rate_per_min: 3 },
      "cache-refresh+archive": { workload_id: "cache-refresh-78", rate_per_min: 3 },
    },
    schedule: PARTICIPANTS.map((participant, index) =>
      sample({
        sample_id: "broken-nginx--concurrent-4-prepared--candidate--00" + (index + 1),
        participant_id: participant,
      }),
    ),
  };
}

function serialPlan() {
  const plan = concurrentPlan();
  plan.schedule = PARTICIPANTS.map((participant, index) =>
    sample({
      sample_id: "broken-nginx--serial-prepared--candidate--00" + (index + 1),
      participant_id: participant,
      condition: "serial-prepared",
      launch_group: "group-0002",
      launch_concurrency: 1,
    }),
  );
  return plan;
}

interface World {
  deps: CampaignDeps;
  commands: string[][];
  runnerCommands: string[][];
  cleanupCommands: string[][];
  recordCommands: string[][];
  inFlight: number;
  maxInFlight: number;
  runnerExitCodes: Map<string, number>;
  skipAcceptedFor: Set<string>;
  cleanupExitCode: number;
  attestation: Record<string, unknown> | null;
  attestExitCode: number;
  workloadEventsUnsupported: boolean;
  cleanupFailureFor: Set<string>;
  sleeps: number;
  files: Map<string, string>;
  observations: string[];
  steps: string[];
}

function world(
  plan: unknown,
  options: {
    runnerExitCodes?: Map<string, number>;
    skipAcceptedFor?: Set<string>;
    cleanupExitCode?: number;
    attestation?: Record<string, unknown> | null;
    attestExitCode?: number;
    workloadEventsUnsupported?: boolean;
    existingObservations?: string[];
    leakedObservations?: string[];
    cleanupFailureFor?: Set<string>;
  } = {},
): World {
  let clock = 1_000_000;
  const files = new Map<string, string>();
  const state: World = {
    deps: {
      start: () => ({ completion: Promise.resolve({ code: 0, stdout: "", stderr: "" }) }),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      readJson: (path: string) => JSON.parse(files.get(path) ?? "null") as unknown,
      readText: (path: string) => files.get(path) ?? null,
      writeJson: (path: string, value: unknown) => {
        files.set(path, JSON.stringify(value));
      },
      writeText: (path: string, value: string) => {
        files.set(path, value);
      },
      mkdir: () => {},
      exists: (path: string) => files.has(path),
      sleep: async () => {
        state.sleeps += 1;
        clock += 1_000;
      },
      now: () => {
        clock += 1;
        return clock;
      },
    },
    commands: [],
    runnerCommands: [],
    cleanupCommands: [],
    recordCommands: [],
    inFlight: 0,
    maxInFlight: 0,
    runnerExitCodes: options.runnerExitCodes ?? new Map(),
    skipAcceptedFor: options.skipAcceptedFor ?? new Set(),
    cleanupExitCode: options.cleanupExitCode ?? 0,
    attestation: options.attestation === undefined ? null : options.attestation,
    attestExitCode: options.attestExitCode ?? 0,
    workloadEventsUnsupported: options.workloadEventsUnsupported ?? false,
    cleanupFailureFor: options.cleanupFailureFor ?? new Set<string>(),
    steps: [],
    sleeps: 0,
    files,
    observations: [],
  };
  files.set(options.planFile ?? "/evidence/plan.json", JSON.stringify(plan));
  if (options.existingObservations && options.existingObservations.length > 0) {
    files.set(
      "/evidence/observations.ndjson",
      options.existingObservations
        .map((id) =>
          JSON.stringify({ sample_id: id, status: "success", teardown: "destroyed" }),
        )
        .join("\n") + "\n",
    );
  }
  if (options.leakedObservations && options.leakedObservations.length > 0) {
    files.set(
      "/evidence/observations.ndjson",
      options.leakedObservations
        .map((id) =>
          JSON.stringify({
            sample_id: id,
            status: "success",
            teardown: "failed",
            runtime_run_id: "run-" + id,
          }),
        )
        .join("\n") + "\n",
    );
  }
  for (const participant of PARTICIPANTS) {
    const path = "/state/" + participant + ".json";
    files.set(path, "{}");
  }
  files.set("/evidence/host-attestation.json", JSON.stringify({
    verified: true,
    environment: "benchmark",
    hostname: "bench-eu-1.intar.test",
    hardware: "AMD EPYC 9354",
    cpu_cores: 24,
    memory_mib: 98304,
    active_vms: 0,
    isolation_id: "bench-eu-1",
    controller: "intar-host-controller",
    controller_lease_id: "lease-0123",
    cpu_class: "prod-24-vcpu",
    region: "eu-west",
    production: false,
    basis: "root-provisioned attestation file read over SSH",
  }));

  const runnerSampleId = (command: string[]) => {
    const index = command.indexOf("--run-id");
    return index === -1 ? "" : (command[index + 1] ?? "");
  };

  state.deps.start = (command: string[]): StartedCommand => {
    state.commands.push(command);
    state.runnerCommands.push(command);
    state.steps.push("runner:" + runnerSampleId(command));
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const sampleId = runnerSampleId(command);
    if (!state.skipAcceptedFor.has(sampleId)) {
      const acceptedIndex = command.indexOf("--on-run-accepted-output");
      const acceptedPath = acceptedIndex === -1 ? "" : (command[acceptedIndex + 1] ?? "");
      files.set(acceptedPath, JSON.stringify({ runId: "run-" + sampleId, reused: false }));
      const outputIndex = command.indexOf("--output");
      const browserPath = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(
        browserPath,
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-" + sampleId,
          scenarioId: "broken-nginx",
          clientRttMs: 24,
        }),
      );
    }
    const exitCode = state.runnerExitCodes.get(sampleId) ?? 0;
    const completion = Promise.resolve<CommandResult>({
      code: exitCode,
      stdout: "",
      stderr: exitCode === 0 ? "" : "playwright benchmark failed: simulated",
    }).then((result) => {
      state.inFlight -= 1;
      return result;
    });
    return { completion };
  };

  state.deps.run = async (command: string[]): Promise<CommandResult> => {
    state.commands.push(command);
    if (command.includes("attest")) {
      return { code: state.attestExitCode, stdout: "", stderr: "" };
    }
    if (command.includes("pressure-capture")) {
      const outputIndex = command.indexOf("--output");
      const path = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(path, JSON.stringify({ captured_unix_ms: 1_757_700_000_000 }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.includes("cgroup-capture")) {
      const outputIndex = command.indexOf("--output");
      const path = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(path, JSON.stringify({ captured_unix_ms: 1_757_700_000_000 }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.includes("workload-events")) {
      if (state.workloadEventsUnsupported) {
        return { code: UNSUPPORTED_EXIT_CODE, stdout: "", stderr: "" };
      }
      const outputIndex = command.indexOf("--output");
      const path = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(
        path,
        JSON.stringify({
          schema_version: 2,
          kind: "vm-boot-benchmark-workload-events",
          host: "bench-eu-1.intar.test",
          captured_unix_ms: 1_757_700_999_000,
          events: [
            {
              unix_ms: 1_757_700_500_000,
              workload: "cache-refresh",
              source: "intar-agent",
              message: "running image cache pass",
            },
          ],
        }),
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.includes("agent-events")) {
      const outputIndex = command.indexOf("--output");
      const path = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(path, "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.includes("host-delta")) {
      const outputIndex = command.indexOf("--output");
      const path = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(path, JSON.stringify({ placeholder: "delta" }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.includes("record")) {
      state.recordCommands.push(command);
      state.steps.push(
        "record:" +
          (command[command.indexOf("--sample-id") + 1] ?? "") +
          ":" +
          (command[command.indexOf("--teardown") + 1] ?? ""),
      );
      const statusIndex = command.indexOf("--status");
      const sampleIndex = command.indexOf("--sample-id");
      const sampleId = sampleIndex === -1 ? "" : (command[sampleIndex + 1] ?? "");
      state.observations.push(
        JSON.stringify({
          sample_id: sampleId,
          status: statusIndex === -1 ? "success" : (command[statusIndex + 1] ?? "success"),
          teardown:
            command.indexOf("--teardown") === -1
              ? "destroyed"
              : (command[command.indexOf("--teardown") + 1] ?? "destroyed"),
          runtime_run_id:
            command.indexOf("--run-id") === -1
              ? null
              : (command[command.indexOf("--run-id") + 1] ?? null),
        }),
      );
      const outputIndex = command.indexOf("--output");
      const path = outputIndex === -1 ? "" : (command[outputIndex + 1] ?? "");
      files.set(path, state.observations.join("\n") + "\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.some((part) => part.endsWith("playwright-cleanup.ts"))) {
      state.cleanupCommands.push(command);
      const cleanupRunId = command[command.indexOf("--run-id") + 1] ?? "";
      state.steps.push("teardown:" + cleanupRunId);
      const sampleId = cleanupRunId.replace(/^run-/u, "");
      if (state.cleanupFailureFor.has(sampleId)) {
        return { code: 1, stdout: "", stderr: "cleanup failed for " + sampleId };
      }
      if (state.cleanupExitCode !== 0) {
        return { code: state.cleanupExitCode, stdout: "", stderr: "cleanup failed" };
      }
      return { code: 0, stdout: JSON.stringify({ state: "absent", polls: 1 }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  if (state.attestation !== null) {
    files.set("/evidence/host-attestation.json", JSON.stringify(state.attestation));
  }
  return state;
}

function options(planFile = "/evidence/plan.json") {
  return {
    plan: planFile,
    observations: "/evidence/observations.ndjson",
    evidenceDir: "/evidence",
    output: "/evidence/campaign.json",
    origin: ORIGIN,
    startPage: START_PAGE,
    participantStorageState: new Map(
      PARTICIPANTS.map((participant) => [participant, "/state/" + participant + ".json"]),
    ),
    hostAdapter: ["/usr/local/bin/intar-bench-host"],
    onlyGroup: null,
    runnerCommand: ["bun", "tools/vm-boot-benchmark/playwright-runner.ts"],
    cleanupCommand: ["bun", "tools/vm-boot-benchmark/playwright-cleanup.ts"],
    toolCommand: ["python3", "tools/vm-boot-benchmark.py"],
    timeoutMs: 120_000,
  };
}

describe("benchmark campaign driver", () => {
  test("launches a four-sample group at once with four distinct participants", async () => {
    const plan = concurrentPlan();
    const state = world(plan);

    const report = await runCampaign(options(), state.deps);

    expect(state.maxInFlight).toBe(4);
    expect(state.runnerCommands).toHaveLength(4);
    expect(
      new Set(state.runnerCommands.map((command) => command[command.indexOf("--participant-id") + 1])),
    ).toEqual(new Set(PARTICIPANTS));
    expect(state.cleanupCommands).toHaveLength(4);
    expect(state.recordCommands).toHaveLength(4);
    expect(state.recordCommands.every((command) => command.includes("--client-rtt-ms"))).toBeTrue();
    expect(report.samples.filter((entry) => entry.status === "recorded")).toHaveLength(4);
    expect(report.aborted).toBeNull();
    expect(report.host_attestation.verified).toBeTrue();
    expect(report.measurement.host_attested).toBeTrue();
  });

  test("runs a serial group one sample at a time", async () => {
    const plan = serialPlan();
    const state = world(plan);

    const report = await runCampaign(options(), state.deps);

    expect(state.maxInFlight).toBe(1);
    expect(state.runnerCommands).toHaveLength(4);
    expect(state.cleanupCommands).toHaveLength(4);
    expect(report.samples).toHaveLength(4);
    expect(report.aborted).toBeNull();
  });

  test("records a failed boot and still tears the run down", async () => {
    const plan = concurrentPlan();
    const failedSample = plan.schedule[1]!;
    const state = world(plan, {
      runnerExitCodes: new Map([[failedSample.sample_id, 1]]),
    });

    const report = await runCampaign(options(), state.deps);

    const entry = report.samples.find((item) => item.sample_id === failedSample.sample_id)!;
    expect(entry.status).toBe("failed");
    expect(entry.failure_code).toBe("terminal_failed");
    expect(entry.run_id).toBe("run-" + failedSample.sample_id);
    expect(entry.teardown).toBe("destroyed");
    expect(
      state.cleanupCommands.some((command) => command.includes("run-" + failedSample.sample_id)),
    ).toBeTrue();
    expect(
      state.recordCommands.some(
        (command) =>
          command.includes(failedSample.sample_id) &&
          command.includes("--status") &&
          command.includes("failure"),
      ),
    ).toBeTrue();
    const other = report.samples.find((item) => item.sample_id === plan.schedule[0]!.sample_id)!;
    expect(other.status).toBe("recorded");
  });

  test("records a start failure that never produced a run without teardown", async () => {
    const plan = serialPlan();
    const failedSample = plan.schedule[0]!;
    const state = world(plan, {
      runnerExitCodes: new Map([[failedSample.sample_id, 1]]),
      skipAcceptedFor: new Set([failedSample.sample_id]),
    });

    const report = await runCampaign(options(), state.deps);

    const entry = report.samples.find((item) => item.sample_id === failedSample.sample_id)!;
    expect(entry.failure_code).toBe("start_failed");
    expect(entry.run_id).toBeNull();
    expect(entry.teardown).toBe("not-needed");
    expect(state.cleanupCommands).toHaveLength(3);
  });

  test("stops the next group when a run did not finish teardown", async () => {
    const plan = concurrentPlan();
    plan.schedule = [
      ...plan.schedule.map((entry) => ({ ...entry })),
      ...serialPlan().schedule,
    ];
    const state = world(plan, { cleanupExitCode: 1 });

    const report = await runCampaign(options(), state.deps);

    expect(state.runnerCommands).toHaveLength(4);
    expect(report.cleanup_failures).toHaveLength(4);
    expect(report.aborted).not.toBeNull();
    expect(report.samples.every((entry) => entry.teardown === "failed")).toBeTrue();
  });

  test("stops before the first sample when the host attestation disagrees", async () => {
    const plan = concurrentPlan();
    const state = world(plan, {
      attestation: {
        verified: true,
        environment: "benchmark",
        hostname: "bench-eu-1.intar.test",
        hardware: "AMD EPYC 9354",
        cpu_cores: 24,
        memory_mib: 98304,
        active_vms: 0,
        isolation_id: "a-production-host",
        controller: "intar-host-controller",
        controller_lease_id: "lease-0123",
        cpu_class: "prod-24-vcpu",
        region: "eu-west",
        production: false,
        basis: "root-provisioned attestation file read over SSH",
      },
    });

    await expect(runCampaign(options(), state.deps)).rejects.toThrow(
      "the host attestation does not match the run manifest",
    );
    expect(state.runnerCommands).toHaveLength(0);
  });

  test("stops before the first sample when the adapter cannot attest", async () => {
    const plan = concurrentPlan();
    const state = world(plan, { attestExitCode: UNSUPPORTED_EXIT_CODE });

    await expect(runCampaign(options(), state.deps)).rejects.toThrow(
      "cannot attest the isolated host",
    );
    expect(state.runnerCommands).toHaveLength(0);
    expect(state.commands).toHaveLength(1);
  });

  test("measures before teardown and records the teardown outcome", async () => {
    const plan = serialPlan();
    const state = world(plan);

    const report = await runCampaign({ ...options(), onlyGroup: "group-0002" }, state.deps);

    // For one sample the order is: runner, teardown, record.
    const first = plan.schedule[0]!;
    const runnerIndex = state.steps.indexOf("runner:" + first.sample_id);
    const teardownIndex = state.steps.indexOf("teardown:run-" + first.sample_id);
    const recordIndex = state.steps.indexOf("record:" + first.sample_id + ":destroyed");
    expect(runnerIndex).toBeGreaterThanOrEqual(0);
    expect(teardownIndex).toBeGreaterThan(runnerIndex);
    expect(recordIndex).toBeGreaterThan(teardownIndex);
    expect(report.samples.every((entry) => entry.teardown === "destroyed")).toBeTrue();

    const recorded = state.recordCommands.filter((command) => command.includes("--teardown"));
    expect(recorded).toHaveLength(4);
  });

  test("records a failed teardown on the last sample and fails the campaign", async () => {
    const plan = serialPlan();
    const last = plan.schedule[3]!;
    const state = world(plan, {
      cleanupFailureFor: new Set([last.sample_id]),
    });

    const report = await runCampaign({ ...options(), onlyGroup: "group-0002" }, state.deps);

    const leaked = report.samples.find((entry) => entry.sample_id === last.sample_id)!;
    expect(leaked.status).toBe("recorded");
    expect(leaked.teardown).toBe("failed");
    expect(report.cleanup_failures).toHaveLength(1);
    expect(report.aborted).not.toBeNull();
    const observation = state.observations.find((line) => line.includes(last.sample_id))!;
    expect(observation).toContain('"teardown":"failed"');

    // A resumed campaign must not skip the leaked run.
    const resumed = world(plan, { leakedObservations: [last.sample_id] });
    await expect(runCampaign(options(), resumed.deps)).rejects.toThrow(
      "did not finish teardown",
    );
    expect(resumed.runnerCommands).toHaveLength(0);
  });

  test("skips a sample that the observations file already has", async () => {
    const plan = concurrentPlan();
    const first = plan.schedule[0]!;
    const state = world(plan, { existingObservations: [first.sample_id] });

    const report = await runCampaign(options(), state.deps);

    expect(report.skipped_sample_ids).toEqual([first.sample_id]);
    expect(state.runnerCommands).toHaveLength(3);
    expect(state.runnerCommands.some((command) => command.includes(first.sample_id))).toBeFalse();
  });

  test("needs a host adapter and validates the plan before any host action", async () => {
    const plan = concurrentPlan();
    const state = world(plan);
    const withoutAdapter = options();
    withoutAdapter.hostAdapter = [];

    await expect(runCampaign(withoutAdapter, state.deps)).rejects.toThrow("--host-adapter");
    expect(state.commands).toHaveLength(0);
    expect(() => requireHostAdapter(withoutAdapter)).toThrow(HOST_ADAPTER_VERBS.join(", "));

    const unsafe = concurrentPlan();
    unsafe.schedule[0] = { ...unsafe.schedule[0]!, scenario_id: "broken-nginx; rm -rf /" };
    const unsafeState = world(unsafe);
    await expect(runCampaign(options(), unsafeState.deps)).rejects.toThrow(
      "plan scenario ID has an invalid format",
    );
  });

  test("parses the campaign arguments and defaults to the existing tools", () => {
    const parsed = parseCampaignArguments([
      "--plan",
      "/tmp/plan.json",
      "--observations",
      "/tmp/observations.ndjson",
      "--evidence-dir",
      "/tmp/evidence",
      "--output",
      "/tmp/campaign.json",
      "--origin",
      ORIGIN,
      "--start-page",
      START_PAGE,
      "--participant-storage-state",
      "bench-a=/tmp/a.json",
      "--participant-storage-state=bench-b=/tmp/b.json",
      "--host-adapter",
      "/usr/local/bin/intar-bench-host",
      "--group",
      "concurrent-4-prepared-0001",
    ]);

    expect(parsed.runnerCommand).toEqual([
      "bun",
      "tools/vm-boot-benchmark/playwright-runner.ts",
    ]);
    expect(parsed.cleanupCommand).toEqual([
      "bun",
      "tools/vm-boot-benchmark/playwright-cleanup.ts",
    ]);
    expect(parsed.toolCommand).toEqual(["python3", "tools/vm-boot-benchmark.py"]);
    expect(parsed.participantStorageState.get("bench-b")).toBe("/tmp/b.json");
    expect(parsed.onlyGroup).toBe("concurrent-4-prepared-0001");

    expect(() => parseCampaignArguments(["--plan", "/tmp/plan.json", "--nope"])).toThrow(
      "unknown option",
    );
    const withoutAdapter = parseCampaignArguments([
      "--plan",
      "/tmp/plan.json",
      "--observations",
      "/tmp/observations.ndjson",
      "--evidence-dir",
      "/tmp/evidence",
      "--output",
      "/tmp/campaign.json",
      "--origin",
      ORIGIN,
      "--start-page",
      START_PAGE,
      "--participant-storage-state",
      "bench-a=/tmp/a.json",
    ]);
    expect(withoutAdapter.hostAdapter).toEqual([]);
    expect(() => requireHostAdapter(withoutAdapter)).toThrow("--host-adapter");
  });

  test("holds the planned launch order and refuses a broken group", () => {
    const groups = planGroups(concurrentPlan());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.concurrency).toBe(4);
    expect(groups[0]!.samples).toHaveLength(4);

    const mixed = concurrentPlan();
    mixed.schedule[1] = { ...mixed.schedule[1]!, launch_concurrency: 1 };
    expect(() => planGroups(mixed)).toThrow("mixes conditions or concurrency");

    const reused = concurrentPlan();
    reused.schedule[1] = { ...reused.schedule[1]!, participant_id: PARTICIPANTS[0]! };
    expect(() => planGroups(reused)).toThrow("reuses a participant");

    const tooWide = concurrentPlan();
    tooWide.schedule[0] = { ...tooWide.schedule[0]!, launch_concurrency: 8 };
    expect(() => planGroups(tooWide)).toThrow("launch concurrency");
  });


  test("passes only flags that the real tool accepts", async () => {
    const tool = "tools/vm-boot-benchmark.py";
    const acceptedFlags = (command: string) => {
      const output = Bun.spawnSync(["python3", tool, command, "--help"]);
      const help = new TextDecoder().decode(output.stdout);
      return new Set([...help.matchAll(/--[a-z][a-z-]+/gu)].map((match) => match[0]));
    };
    const plan = concurrentPlan();
    plan.schedule[1] = {
      ...plan.schedule[1]!,
      condition: "concurrent-4-background-cache-archive",
      background_workload: "cache-refresh+archive",
      launch_group: "group-0009",
      launch_concurrency: 1,
    };
    const state = world(plan);

    await runCampaign(options(), state.deps);

    expect(state.recordCommands.length).toBeGreaterThan(0);
    const recordFlags = acceptedFlags("record");
    for (const command of state.recordCommands) {
      for (const argument of command.slice(command.indexOf("record") + 1)) {
        if (argument.startsWith("--")) expect(recordFlags.has(argument)).toBeTrue();
      }
    }
    const withWorkload = state.recordCommands.filter((command) =>
      command.includes("--cache-refresh-id"),
    );
    expect(withWorkload).toHaveLength(1);
    expect(withWorkload[0]).toContain("cache-refresh-78");

    const deltaFlags = acceptedFlags("host-delta");
    for (const command of state.commands.filter((entry) => entry.includes("host-delta"))) {
      for (const argument of command) {
        if (argument.startsWith("--")) expect(deltaFlags.has(argument)).toBeTrue();
      }
    }
    const cleanupFlags = new Set(["--origin", "--storage-state", "--run-id", "--timeout-ms"]);
    for (const command of state.cleanupCommands) {
      for (const argument of command) {
        if (argument.startsWith("--")) expect(cleanupFlags.has(argument)).toBeTrue();
      }
    }
  });

  test("proves the background workload from host events, not from the manifest", async () => {
    const plan = concurrentPlan();
    plan.schedule[1] = {
      ...plan.schedule[1]!,
      condition: "serial-background-cache",
      background_workload: "cache-refresh",
      launch_group: "group-0003",
      launch_concurrency: 1,
    };
    plan.background_workloads = { "cache-refresh": { workload_id: "cache-refresh-77", rate_per_min: 3 } };
    const state = world(plan);

    const report = await runCampaign(options(), state.deps);

    const background = state.recordCommands.filter((command) =>
      command.includes("--workload-events"),
    );
    expect(background).toHaveLength(1);
    const proven = report.samples.find((entry) => entry.sample_id === plan.schedule[1]!.sample_id)!;
    expect(proven.status).toBe("recorded");
    expect(report.measurement.background_workloads_proven).toBe(1);
    expect(report.measurement.background_workloads_unproven).toBe(0);
    expect(report.measurement.host_attested).toBeTrue();
    expect(report.measurement.limits.length).toBeGreaterThanOrEqual(3);
  });

  test("records an unproven background workload as a failure", async () => {
    const plan = concurrentPlan();
    plan.schedule[1] = {
      ...plan.schedule[1]!,
      condition: "serial-background-cache",
      background_workload: "cache-refresh",
      launch_group: "group-0003",
      launch_concurrency: 1,
    };
    plan.background_workloads = { "cache-refresh": { workload_id: "cache-refresh-77", rate_per_min: 3 } };
    const state = world(plan, { workloadEventsUnsupported: true });

    const report = await runCampaign(options(), state.deps);

    const unproven = report.samples.find((entry) => entry.sample_id === plan.schedule[1]!.sample_id)!;
    expect(unproven.status).toBe("failed");
    expect(unproven.failure_code).toBe("background_workload_not_observed");
    expect(report.measurement.background_workloads_unproven).toBe(1);
    expect(report.measurement.background_workloads_proven).toBe(0);
    expect(
      state.recordCommands.some(
        (command) =>
          command.includes("--failure-code") &&
          command.includes("background_workload_not_observed"),
      ),
    ).toBeTrue();
  });

  test("keeps the accepted wait bounded when a run never starts", async () => {
    const plan = serialPlan();
    const first = plan.schedule[0]!;
    const state = world(plan, {
      skipAcceptedFor: new Set([first.sample_id]),
      runnerExitCodes: new Map([[first.sample_id, 1]]),
    });

    const report = await runCampaign({ ...options(), onlyGroup: "group-0002" }, state.deps);

    expect(state.sleeps).toBeGreaterThan(0);
    expect(state.sleeps * 1_000).toBeLessThanOrEqual(ACCEPTED_WAIT_MS + 1_000);
    expect(report.samples).toHaveLength(4);
  });
});
