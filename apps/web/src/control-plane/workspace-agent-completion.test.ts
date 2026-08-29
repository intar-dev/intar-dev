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
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const staticCloudInitPath = join(
  repositoryRoot,
  "crates/intar-workspace-agent/examples/cloud-init.yaml",
);

describe("direct-cloud Intar Bash completion", () => {
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

      const completionPath = join(directory, "intar.bash");
      writeFileSync(
        completionPath,
        cloudInitFileContent(
          readFileSync(staticCloudInitPath, "utf8"),
          "/usr/share/intar/completions/intar.bash",
        ).replace(
          "/usr/bin/timeout 0.25s /usr/local/bin/intar",
          bashQuote(fakeIntar),
        ),
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
        { encoding: "utf8" },
      );

      expect(output).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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
