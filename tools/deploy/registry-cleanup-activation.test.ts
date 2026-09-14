import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const activationPath = join(
  repositoryRoot,
  "tools/deploy/registry-cleanup-activation.sh",
);
const script = readFileSync(activationPath, "utf8");
// Every test here spawns the activation step, so the default timeout is too
// tight when the whole suite runs in parallel.
const SPAWN_TIMEOUT_MS = 30_000;
const sourceSha = "a".repeat(40);
const publishToken = "test-publish-token-that-authorizes-the-write";
const activationUrl =
  "https://intar.dev/registry/v1/admission/enforcement";

interface RunOptions {
  mode?: string;
  token?: string | null;
  status?: string;
  body?: string;
}

function fakeCurl(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    'output=""',
    'url=""',
    'request="$(cat)"',
    'printf "%s" "$request" > "$MOCK_CURL_STDIN"',
    'printf "%s\\n" "$@" > "$MOCK_CURL_ARGS"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --output) output="$2"; shift 2 ;;',
    '    --data-binary) shift 2 ;;',
    "    http*) url=\"$1\"; shift ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    'test "$url" = "$MOCK_ACTIVATION_URL" || exit 92',
    'printf "%s" "$MOCK_BODY" > "$output"',
    'printf "%s" "$MOCK_STATUS"',
    "",
  ].join("\n");
}

/** Every artifact this step could leave behind, as the lane uploads them. */
function artifactFiles(run: { runtimeRoot: string; evidencePath: string }) {
  const files: string[] = [];
  if (existsSync(run.runtimeRoot)) {
    for (const entry of readdirSync(run.runtimeRoot)) {
      const path = join(run.runtimeRoot, entry);
      if (existsSync(path)) files.push(path);
    }
  }
  if (existsSync(run.evidencePath)) files.push(run.evidencePath);
  return files;
}

function runActivation(options: RunOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "intar-registry-cleanup-activation-test-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const evidence = join(runnerTemp, "activation.json");
  const curlStdin = join(root, "curl-stdin");
  const curlArgs = join(root, "curl-args");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const curl = join(bin, "curl");
  writeFileSync(curl, fakeCurl());
  chmodSync(curl, 0o755);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: bin + ":" + (process.env.PATH ?? ""),
    RUNNER_TEMP: runnerTemp,
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: "12345",
    REGISTRY_ENFORCEMENT_URL: activationUrl,
    MOCK_ACTIVATION_URL: activationUrl,
    MOCK_STATUS: options.status ?? "200",
    MOCK_BODY:
      options.body ??
      '{"ok":true,"enforcement":"enforce","session_required":true,"sweep_active":false}',
    MOCK_CURL_STDIN: curlStdin,
    MOCK_CURL_ARGS: curlArgs,
  };
  if (options.token === null) {
    env.REGISTRY_PUBLISH_TOKEN = "";
  } else {
    env.REGISTRY_PUBLISH_TOKEN = options.token ?? publishToken;
  }

  const result = spawnSync("bash", [activationPath, options.mode ?? "enforce", evidence], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  const evidenceText = existsSync(evidence) ? readFileSync(evidence, "utf8") : "";
  return {
    result,
    evidenceText,
    evidence: evidenceText.trim()
      ? (JSON.parse(evidenceText) as Record<string, unknown>)
      : null,
    evidencePath: evidence,
    request: existsSync(curlStdin) ? readFileSync(curlStdin, "utf8") : null,
    curlArgs: existsSync(curlArgs) ? readFileSync(curlArgs, "utf8") : null,
    runtimeRoot: join(runnerTemp, "intar-registry-cleanup-activation-12345"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("registry cleanup enforcement activation", () => {
  it("turns the switch on and records the D1 answer", () => {
    const run = runActivation();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.request).toBe('{"mode":"enforce"}');
      expect(run.curlArgs).toContain("Authorization: Bearer " + publishToken);
      expect(run.curlArgs).toContain(activationUrl);
      expect(run.evidence).toMatchObject({
        operation: "registry-cleanup-activation",
        requested_mode: "enforce",
        http_status: "200",
        ok: true,
        problem: null,
        response: {
          ok: true,
          enforcement: "enforce",
          session_required: true,
        },
      });
    } finally {
      run.cleanup();
    }
  });

  it("passes a report_only disable whose session_required is false", () => {
    // jq's `//` reads a boolean false as absent, so the flag is checked for
    // presence and type instead. This disable is the emergency path and it must
    // report success.
    const run = runActivation({
      mode: "report_only",
      body: '{"ok":true,"enforcement":"report_only","session_required":false,"sweep_active":false}',
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        requested_mode: "report_only",
        ok: true,
        problem: null,
        response: { enforcement: "report_only", session_required: false },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a missing or non-boolean session_required flag", () => {
    for (const testCase of [
      { mode: "report_only", body: '{"ok":true,"enforcement":"report_only"}' },
      {
        mode: "report_only",
        body: '{"ok":true,"enforcement":"report_only","session_required":null}',
      },
      {
        mode: "report_only",
        body: '{"ok":true,"enforcement":"report_only","session_required":"false"}',
      },
      { mode: "enforce", body: '{"ok":true,"enforcement":"enforce"}' },
    ]) {
      const run = runActivation({ mode: testCase.mode, body: testCase.body });
      try {
        expect(run.result.status, testCase.body).not.toBe(0);
        expect(run.result.stderr).toContain("carries no session_required flag");
        expect(run.evidence).toMatchObject({ ok: false });
      } finally {
        run.cleanup();
      }
    }
  }, 30_000);

  it("refuses a delete enable whose session_required is false", () => {
    const run = runActivation({
      body: '{"ok":true,"enforcement":"enforce","session_required":false}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "session_required is false while enforcement is enforce",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses a response whose enforcement state is not the requested mode", () => {
    const run = runActivation({
      body: '{"ok":true,"enforcement":"report_only","session_required":false}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the D1 enforcement state is");
      expect(run.evidence).toMatchObject({ ok: false });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a response without the D1 flags", () => {
    for (const body of [
      '{"ok":false}',
      '{"ok":true}',
      '{"ok":true,"enforcement":"enforce"}',
      '{"ok":true,"enforcement":"enforce","session_required":false}',
    ]) {
      const run = runActivation({ body });
      try {
        expect(run.result.status, body).not.toBe(0);
        expect(run.evidence).toMatchObject({ ok: false });
        expect(String((run.evidence as { problem: string }).problem).length).toBeGreaterThan(0);
      } finally {
        run.cleanup();
      }
    }
  }, 30_000);

  it("refuses a non-200 answer", () => {
    const run = runActivation({ status: "403", body: '{"error":"unauthorized"}' });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the activation endpoint answered HTTP 403");
      expect(run.evidence).toMatchObject({ ok: false, http_status: "403" });
    } finally {
      run.cleanup();
    }
  });

  it("refuses an unreadable body", () => {
    const run = runActivation({ body: "not json" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ ok: false });
    } finally {
      run.cleanup();
    }
  });

  it("requires the publish token and never writes it to disk", () => {
    const run = runActivation({ token: null });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("REGISTRY_PUBLISH_TOKEN");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }

    const withToken = runActivation();
    try {
      expect(withToken.result.status, withToken.result.stderr).toBe(0);
      for (const entry of ["response.json", "activation.json"]) {
        const path = join(withToken.runtimeRoot, entry);
        if (!existsSync(path)) continue;
        expect(readFileSync(path, "utf8")).not.toContain(publishToken);
      }
      expect(withToken.evidenceText).not.toContain(publishToken);
      // The script refuses to publish evidence that carries the credential.
      expect(script).toContain("scrub_secret_files");
      expect(script).toContain("removed a file that reflected the registry credential");
    } finally {
      withToken.cleanup();
    }
  });

  it("destroys a reflected token before it fails, on success and on failure", () => {
    // An answer that echoes the credential must not reach the uploaded
    // artifact set, so the offending files are removed and the step fails.
    const reflected = '{"ok":true,"enforcement":"enforce","session_required":true,"echo":"' + publishToken + '"}';
    const cases = [
      { label: "success path", status: "200", body: reflected, evidenceRemoved: true },
      {
        label: "refused path",
        status: "403",
        body: '{"error":"unauthorized","echo":"' + publishToken + '"}',
        evidenceRemoved: true,
      },
      {
        label: "unreadable body",
        status: "200",
        body: "token=" + publishToken,
        // The body never parses, so the evidence embeds null and stays clean.
        evidenceRemoved: false,
      },
    ];
    for (const testCase of cases) {
      const run = runActivation({ status: testCase.status, body: testCase.body });
      try {
        expect(run.result.status, testCase.label).not.toBe(0);
        expect(run.result.stderr).toContain("reflected the registry credential");
        const files = artifactFiles(run);
        for (const file of files) {
          expect(readFileSync(file, "utf8"), file).not.toContain(publishToken);
        }
        // The response that carried the token is always destroyed, and so is
        // the evidence whenever it embedded that response.
        expect(existsSync(join(run.runtimeRoot, "response.json"))).toBe(false);
        if (testCase.evidenceRemoved) {
          expect(run.evidence, testCase.label).toBeNull();
        } else {
          expect(run.evidence, testCase.label).toMatchObject({ response: null });
        }
      } finally {
        run.cleanup();
      }
    }
  }, 30_000);

  it("keeps clean artifacts when nothing reflects the token", () => {
    const run = runActivation();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(existsSync(join(run.runtimeRoot, "response.json"))).toBe(true);
      for (const file of artifactFiles(run)) {
        expect(readFileSync(file, "utf8"), file).not.toContain(publishToken);
      }
    } finally {
      run.cleanup();
    }
  });

  it("rejects an unknown mode", () => {
    const run = runActivation({ mode: "delete" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("mode must be enforce or report_only");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("reads the enrollment switch and not the learner-run CLI rollout", () => {
    expect(script).not.toContain("LEARNER_RUN_CLI_V1_ENFORCEMENT");
    expect(script).toContain("admission/enforcement");
  });
}, SPAWN_TIMEOUT_MS);
