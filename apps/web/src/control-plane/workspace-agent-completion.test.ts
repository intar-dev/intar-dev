import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildWorkspaceAgentCloudInit } from "@/lib/workshops/workspace-agent-control-plane";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const staticCloudInitPath = join(
  repositoryRoot,
  "crates/intar-workspace-agent/examples/cloud-init.yaml",
);

describe("direct-cloud Intar Bash completion", () => {
  it("keeps the static cloud-init example aligned with production output", () => {
    expect(
      cloudInitFileContent(
        readFileSync(staticCloudInitPath, "utf8"),
        "/usr/share/intar/completions/intar.bash",
      ),
    ).toBe(
      cloudInitFileContent(
        renderedCloudInit(),
        "/usr/share/intar/completions/intar.bash",
      ),
    );
  });

  it("does not offer unrelated aliases for intar hint z Tab", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "intar-direct-cloud-completion-"),
    );
    try {
      const fakeIntar = join(directory, "intar");
      writeFileSync(
        fakeIntar,
        [
          "#!/bin/sh",
          'if [ "$1" = __complete ]; then',
          "  printf '%s\\n' general check-1 hint-1",
          "fi",
          "",
        ].join("\n"),
      );
      chmodSync(fakeIntar, 0o755);
      // macOS can spend more than the production 250 ms completion budget on
      // the first launch of a new temp executable. The installed Kino binary
      // is already running in production, so warm this test fixture once.
      execFileSync(fakeIntar, ["__complete", "2", "intar", "hint", "ge"]);

      const completionPath = join(directory, "intar.bash");
      writeFileSync(
        completionPath,
        completionScript({ fakeIntar, timeout: timeoutExecutable() }),
      );

      const output = execFileSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "source " + bashQuote(completionPath),
            "COMP_WORDS=(intar hint z)",
            "COMP_CWORD=2",
            "COMPREPLY=()",
            "_intar_complete",
            'if ((${#COMPREPLY[@]})); then printf "%s\\n" "${COMPREPLY[@]}"; fi',
          ].join("\n"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );

      expect(output).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads rendered completion through Bash interactive startup", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "intar-direct-cloud-completion-"),
    );
    try {
      const fakeIntar = join(directory, "intar");
      writeFileSync(
        fakeIntar,
        [
          "#!/bin/sh",
          'if [ "$1" = __complete ]; then',
          "  printf '%s\\n' general",
          "fi",
          "",
        ].join("\n"),
      );
      chmodSync(fakeIntar, 0o755);
      execFileSync(fakeIntar, ["__complete", "2", "intar", "hint", "ge"]);

      const completionPath = join(directory, "intar.bash");
      writeFileSync(
        completionPath,
        completionScript({ fakeIntar, timeout: timeoutExecutable() }),
      );
      const bashRcPath = join(directory, "bashrc");
      writeFileSync(bashRcPath, bashRcScript(completionPath));

      const output = execFileSync(
        "bash",
        [
          "--noprofile",
          "--rcfile",
          bashRcPath,
          "-ic",
          [
            "complete -p intar",
            "COMP_WORDS=(intar hint ge)",
            "COMP_CWORD=2",
            "COMPREPLY=()",
            "_intar_complete",
            'printf "%s\\n" "${COMPREPLY[*]}"',
          ].join("\n"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );

      expect(output).toContain("complete -F _intar_complete intar");
      expect(output).toContain("general");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hard stops a completion helper that ignores TERM", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "intar-direct-cloud-completion-"),
    );
    try {
      const fakeIntar = join(directory, "intar");
      writeFileSync(
        fakeIntar,
        [
          "#!/bin/sh",
          "trap '' TERM",
          "exec sleep 30",
          "",
        ].join("\n"),
      );
      chmodSync(fakeIntar, 0o755);

      const completionPath = join(directory, "intar.bash");
      writeFileSync(
        completionPath,
        completionScript({ fakeIntar, timeout: timeoutExecutable() }),
      );

      const startedAt = Date.now();
      const output = execFileSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "source " + bashQuote(completionPath),
            "COMP_WORDS=(intar hint)",
            "COMP_CWORD=2",
            "COMPREPLY=()",
            "_intar_complete",
            '(( ${#COMPREPLY[@]} == 0 ))',
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );

      expect(output).toBe("");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function completionScript(input: {
  fakeIntar: string;
  timeout: string;
}): string {
  return cloudInitFileContent(
    renderedCloudInit(),
    "/usr/share/intar/completions/intar.bash",
  )
    .replace("/usr/bin/timeout", bashQuote(input.timeout))
    .replace("/usr/local/bin/intar", bashQuote(input.fakeIntar));
}

function bashRcScript(completionPath: string): string {
  return cloudInitFileContent(
    renderedCloudInit(),
    "/etc/bash.bashrc",
  ).replaceAll(
    "/usr/share/intar/completions/intar.bash",
    bashQuote(completionPath),
  );
}

function renderedCloudInit(): string {
  return buildWorkspaceAgentCloudInit({
    identity: {
      executionId: "execution-1",
      workspaceId: "workspace-1",
      generation: 1,
    },
    endpoint: "https://intar.test/api/runtime/workspace-agent/",
    bootstrapCapability: "test-bootstrap-capability",
    sshPublicKey: "ssh-ed25519 AAAATEST intar",
    agentBinaryUrl: "https://releases.intar.dev/workspace-agent",
    agentBinarySha256: "b".repeat(64),
    kinoBinaryUrl: "https://releases.intar.dev/kino",
    kinoBinarySha256: "c".repeat(64),
    kinoProbes: [{ moduleId: "00", probeId: "module-00-workspace-ready" }],
    checkpointSigningKeysJson:
      '{"test-key":"11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="}',
    runCliEnabled: true,
  });
}

function timeoutExecutable(): string {
  const timeout = execFileSync(
    "bash",
    ["-c", "command -v timeout || command -v gtimeout"],
    { encoding: "utf8" },
  ).trim();
  expect(timeout).not.toBe("");
  return timeout;
}

function cloudInitFileContent(document: string, path: string): string {
  const fileStart = document.indexOf("  - path: " + path + "\n");
  expect(fileStart).toBeGreaterThanOrEqual(0);
  const contentMarker = "    content: |\n";
  const contentStart = document.indexOf(contentMarker, fileStart);
  expect(contentStart).toBeGreaterThanOrEqual(0);
  const nextFile = document.indexOf(
    "\n  - path: ",
    contentStart + contentMarker.length,
  );
  const contentEnd = nextFile >= 0 ? nextFile : document.length;
  return document
    .slice(contentStart + contentMarker.length, contentEnd)
    .split("\n")
    .map((line) => (line.startsWith("      ") ? line.slice(6) : line))
    .join("\n");
}

function bashQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
