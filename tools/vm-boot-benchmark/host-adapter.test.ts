import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ADAPTER = join(REPO_ROOT, "tools/vm-boot-benchmark/host-adapter.sh");
const WORKLOAD = join(REPO_ROOT, "tools/vm-boot-benchmark/workload-events.py");
const ATTESTATION = join(REPO_ROOT, "tools/vm-boot-benchmark/host-attestation.py");

const temporaryRoots: string[] = [];

interface Fixture {
  root: string;
  binDir: string;
  evidence: string;
  logPath: string;
}

function defaultAttestation() {
  return {
    isolation_id: "bench-eu-1",
    controller: "intar-host-controller",
    controller_lease_id: "lease-0123",
    cpu_class: "prod-24-vcpu",
    region: "eu-west",
    environment: "benchmark",
    production: false,
  };
}

/**
 * Build a fixture host for the adapter tests.
 *
 * The fake ssh runs the shipped programs unchanged. It presents the fixture
 * host through a python3 shim: the shim reads the program from stdin and
 * replaces open() for the kernel paths the program reads, plus the agent VM
 * endpoint. Nothing in the production adapter knows about the fixture, and no
 * environment variable can reach the shipped program.
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "intar-adapter-"));
  temporaryRoots.push(root);
  const hostRoot = join(root, "host");
  const binDir = join(root, "bin");
  const evidence = join(root, "evidence");
  for (const directory of [
    join(hostRoot, "proc/sys/kernel"),
    join(hostRoot, "etc/intar-benchmark"),
    binDir,
    evidence,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(hostRoot, "proc/sys/kernel/hostname"), "bench-eu-1.intar.test\n");
  writeFileSync(
    join(hostRoot, "proc/cpuinfo"),
    [
      "processor\t: 0",
      "model name\t: AMD EPYC 9354 24-Core Processor",
      "processor\t: 1",
      "model name\t: AMD EPYC 9354 24-Core Processor",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(hostRoot, "proc/meminfo"),
    "MemTotal:       98304000 kB\nMemFree:        1024 kB\n",
  );
  writeFileSync(
    join(hostRoot, "etc/intar-benchmark/attestation.json"),
    JSON.stringify(defaultAttestation()),
  );
  writeFileSync(join(hostRoot, "agent-vms.json"), "[]");
  const logPath = join(root, "remote-commands.log");

  // The python3 shim presents the fixture host to the shipped program.
  const preload = join(root, "preload.py");
  writeFileSync(
    preload,
    [
      "import builtins, json, os, sys, urllib.request",
      "root = os.environ.get('INTAR_FIXTURE_HOST_ROOT', '')",
      "inventory = os.environ.get('INTAR_FIXTURE_INVENTORY', '')",
      "real_open = builtins.open",
      "def fixture_open(file, *args, **kwargs):",
      "    path = str(file)",
      "    if root and (path.startswith('/proc/') or path.startswith('/etc/intar-benchmark/')):",
      "        return real_open(root + path, *args, **kwargs)",
      "    return real_open(file, *args, **kwargs)",
      "builtins.open = fixture_open",
      "class FixtureResponse:",
      "    def __init__(self, payload): self.payload = payload",
      "    def read(self): return self.payload",
      "    def __enter__(self): return self",
      "    def __exit__(self, *rest): return False",
      "def fixture_urlopen(url, timeout=None):",
      "    if str(url).endswith('/vms'):",
      "        return FixtureResponse(real_open(inventory, 'rb').read())",
      "    raise OSError('the fixture host has no ' + str(url))",
      "urllib.request.urlopen = fixture_urlopen",
      "program = sys.stdin.read()",
      "sys.argv = ['remote'] + sys.argv[2:]",
      "exec(compile(program, 'remote-program', 'exec'), {'__name__': '__main__'})",
      "",
    ].join("\n"),
  );
  const shim = join(binDir, "python3");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      "exec \"$INTAR_FIXTURE_REAL_PYTHON\" \"$INTAR_FIXTURE_PRELOAD\" \"$@\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);

  // The fake ssh logs the remote command and serves the fixture host.
  const fakeSsh = join(binDir, "ssh");
  writeFileSync(
    fakeSsh,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -o) shift 2 ;;",
      "    --) shift; break ;;",
      "    *) break ;;",
      "  esac",
      "done",
      "target=\"$1\"; shift",
      "command=\"$1\"",
      "printf '%s\\n' \"$command\" >> \"$INTAR_BENCH_LOG\"",
      "case \"$command\" in",
      "  *--attestation-file*|*--start-unix-ms*)",
      "    # The shipped program runs here with the fixture host presented.",
      "    set -- $command",
      "    shift 2",
      "    exec python3 - \"$@\"",
      "    ;;",
      "  *capture-host-pressure*)",
      "    printf '%s\\n' '{\"schema_version\":2,\"kind\":\"host-pressure-snapshot\",\"captured_unix_ms\":1757700000000,\"host_pressure_us\":{\"cpu\":{\"some_total_us\":1,\"full_total_us\":0},\"io\":{\"some_total_us\":1,\"full_total_us\":0},\"memory\":{\"some_total_us\":1,\"full_total_us\":0}}}'",
      "    ;;",
      "  *capture-run-host*)",
      "    printf '%s\\n' '{\"schema_version\":2,\"kind\":\"run-cgroup-snapshot\",\"captured_unix_ms\":1757700000000,\"vm_cgroups\":{}}'",
      "    ;;",
      "  *extract-agent-events*)",
      "    cat",
      "    ;;",
      "  *)",
      "    printf 'the fixture host has no command: %s\\n' \"$command\" >&2",
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(fakeSsh, 0o755);

  // A fake journalctl for the workload helper on a host without systemd.
  const fakeJournalctl = join(binDir, "journalctl");
  writeFileSync(
    fakeJournalctl,
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"__REALTIME_TIMESTAMP\":\"1757699970000000\",\"MESSAGE\":\"image_cache: running image cache pass\"}'",
      "printf '%s\\n' '{\"__REALTIME_TIMESTAMP\":\"1757699980000000\",\"MESSAGE\":\"scenario_run_archive_started run_id=run-1 vm=vm-1\"}'",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(fakeJournalctl, 0o755);
  return { root, binDir, evidence, logPath };
}

interface AdapterRun {
  code: number;
  stdout: string;
  stderr: string;
  commands: string[];
}

function runAdapter(
  fx: Fixture,
  args: string[],
  options: { inventory?: unknown; attestation?: unknown } = {},
): AdapterRun {
  if (options.inventory !== undefined) {
    writeFileSync(join(fx.root, "host/agent-vms.json"), JSON.stringify(options.inventory));
  }
  if (options.attestation !== undefined) {
    writeFileSync(
      join(fx.root, "host/etc/intar-benchmark/attestation.json"),
      JSON.stringify(options.attestation),
    );
  }
  const realPython = Bun.which("python3");
  if (!realPython) throw new Error("python3 is not on PATH");
  const result = Bun.spawnSync(
    [
      "bash",
      ADAPTER,
      "--host",
      "root@bench-1",
      "--attestation-file",
      "/etc/intar-benchmark/attestation.json",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: fx.binDir + ":" + (process.env.PATH ?? ""),
        INTAR_BENCH_LOG: fx.logPath,
        INTAR_FIXTURE_HOST_ROOT: join(fx.root, "host"),
        INTAR_FIXTURE_INVENTORY: join(fx.root, "host/agent-vms.json"),
        INTAR_FIXTURE_PRELOAD: join(fx.root, "preload.py"),
        INTAR_FIXTURE_REAL_PYTHON: realPython,
      },
    },
  );
  const commands = existsSync(fx.logPath)
    ? readFileSync(fx.logPath, "utf8").split("\n").filter(Boolean)
    : [];
  return {
    code: result.exitCode ?? 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    commands,
  };
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("host adapter script", () => {
  test("the shipped programs take no environment override", () => {
    const adapterSource = readFileSync(ADAPTER, "utf8");
    expect(adapterSource).not.toContain("INTAR_BENCH_HOST_ROOT");
    expect(adapterSource).not.toContain("INTAR_BENCH_VM_INVENTORY");
    const attestationSource = readFileSync(ATTESTATION, "utf8");
    // The program never imports os, so os.environ cannot reach it.
    expect(attestationSource).not.toContain("import os");
    expect(attestationSource).not.toContain("os.environ");
    expect(attestationSource).not.toContain("getenv");
    expect(attestationSource).toContain("/proc/sys/kernel/hostname");
  });

  test("attests from the host files that the remote program reads", () => {
    const fx = fixture();
    const output = join(fx.evidence, "host-attestation.json");
    const run = runAdapter(fx, ["attest", "--output", output]);

    // The adapter logs its own progress on stderr; the attestation itself is clean.
    expect(run.stderr).not.toContain("host-attestation:");
    expect(run.code).toBe(0);
    const attestation = JSON.parse(readFileSync(output, "utf8"));
    expect(attestation.verified).toBe(true);
    expect(attestation.hostname).toBe("bench-eu-1.intar.test");
    expect(attestation.cpu_cores).toBe(2);
    expect(attestation.hardware).toContain("AMD EPYC 9354");
    expect(attestation.active_vms).toBe(0);
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).toContain("--attestation-file=");
  });

  test("refuses a host that is not the benchmark environment or still holds VMs", () => {
    const fx = fixture();
    const output = join(fx.evidence, "host-attestation.json");
    const production = runAdapter(fx, ["attest", "--output", output], {
      attestation: { ...defaultAttestation(), environment: "production" },
    });
    expect(production.code).toBe(4);
    expect(production.stderr).toContain("benchmark environment");

    const busy = runAdapter(fx, ["attest", "--output", output], {
      inventory: [{ name: "vm-1" }],
      attestation: defaultAttestation(),
    });
    expect(busy.code).toBe(4);
    expect(busy.stderr).toContain("active VMs");
  });

  test("reads the workload intervals from the host journal", () => {
    const fx = fixture();
    const output = join(fx.evidence, "workload-events.json");
    const run = runAdapter(fx, [
      "workload-events",
      "--start-unix-ms",
      "1757700000000",
      "--end-unix-ms",
      "1757700002000",
      "--output",
      output,
    ]);

    expect(run.code).toBe(0);
    const document = JSON.parse(readFileSync(output, "utf8"));
    expect(document.kind).toBe("vm-boot-benchmark-workload-events");
    const workloads = document.events.map((event: { workload: string }) => event.workload);
    expect(workloads).toContain("cache-refresh");
    expect(workloads).toContain("archive");
    const archive = document.events.find(
      (event: { workload: string }) => event.workload === "archive",
    );
    expect(archive.kind).toBe("start");
    expect(archive.job).toContain("run-1");
    expect(run.commands[0]).toContain("--start-unix-ms");
  });

  test("refuses an argument that could reach the remote shell", () => {
    const fx = fixture();
    const output = join(fx.evidence, "cgroup.json");
    const injected = runAdapter(fx, [
      "cgroup-capture",
      "--run-id",
      "run-1; touch /tmp/intar-pwned",
      "--expected-vm-count",
      "1",
      "--wait-seconds",
      "0",
      "--output",
      output,
    ]);
    expect(injected.code).not.toBe(0);
    expect(injected.stderr).toContain("unsupported characters");
    expect(injected.commands).toHaveLength(0);

    const numeric = runAdapter(fx, [
      "cgroup-capture",
      "--run-id",
      "run-1",
      "--expected-vm-count",
      "1; touch /tmp/intar-pwned",
      "--wait-seconds",
      "0",
      "--output",
      output,
    ]);
    expect(numeric.code).not.toBe(0);
    expect(numeric.stderr).toContain("non-negative integer");
    expect(numeric.commands).toHaveLength(0);

    const unknown = runAdapter(fx, [
      "cgroup-capture",
      "--run-id",
      "run-1",
      "--nope",
      "1",
      "--output",
      output,
    ]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.commands).toHaveLength(0);
  });

  test("quotes every remote argument and rejects a leading-dash value", () => {
    const fx = fixture();
    const output = join(fx.evidence, "cgroup.json");
    const run = runAdapter(fx, [
      "cgroup-capture",
      "--run-id",
      "run-1",
      "--expected-vm-count",
      "3",
      "--wait-seconds",
      "0",
      "--output",
      output,
    ]);
    expect(run.code).toBe(0);
    const command = run.commands[0]!;
    expect(command).toContain("capture-run-host");
    expect(command).toContain("run-1");

    const dash = Bun.spawnSync(
      ["bash", ADAPTER, "--host", "-oProxyCommand=evil", "pressure-capture", "--output", output],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(dash.exitCode).not.toBe(0);
    expect(dash.stderr.toString()).toContain("must not start with a dash");
  });

  test("dispatches the evidence verbs through the host adapter", () => {
    const fx = fixture();
    const pressure = join(fx.evidence, "pressure.json");
    const agent = join(fx.evidence, "agent-events.ndjson");

    const pressureRun = runAdapter(fx, ["pressure-capture", "--output", pressure], {});
    expect(pressureRun.code).toBe(0);
    expect(JSON.parse(readFileSync(pressure, "utf8")).kind).toBe("host-pressure-snapshot");
    expect(pressureRun.commands[0]).toContain("capture-host-pressure");

    const agentRun = runAdapter(fx, ["agent-events", "--run-id", "run-1", "--output", agent], {});
    expect(agentRun.code).toBe(0);
    expect(
      agentRun.commands.some((command) => command.includes("extract-agent-events")),
    ).toBeTrue();

    const unknownVerb = runAdapter(fx, ["teleport", "--output", pressure], {});
    expect(unknownVerb.code).toBe(2);
    expect(unknownVerb.stderr).toContain("unknown argument");
  });

  test("keeps the archive events in the on-host workload helper", () => {
    const source = readFileSync(WORKLOAD, "utf8");
    expect(source).toContain("scenario_run_archive");
    expect(source).toContain("queued durable archive job");
    expect(source).toContain("started archive job");
    expect(source).toContain("archive job failed and will be retried");
    expect(source).toContain("archive job completed");
    // The cache-refresh needles are the pass message and the scrub batch
    // message. Both are logged in every cache refresh scope, so the helper does
    // not depend on a scope name: the current release has Scrub and
    // MissingOnly, and no needle mentions a scope value.
    expect(source).toContain("running image cache pass");
    expect(source).toContain("image cache scrub batch");
    expect(source).not.toContain("FullRepair");
    expect(source).not.toContain("MissingOnly");
    expect(source).not.toContain("scope=");
  });
});
