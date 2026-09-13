import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import { checkWorkflowSyntax } from "./check-workflow-syntax";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function check(source: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "intar-workflow-syntax-"));
  roots.push(root);
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "sample.yml"), source);
  return checkWorkflowSyntax(root);
}

function workflow(steps: readonly string[]): string {
  return [
    "name: Sample",
    "on: workflow_dispatch",
    "jobs:",
    "  sample:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    ...steps,
    "",
  ].join("\n");
}

describe("workflow shell syntax gate", () => {
  it("accepts every workflow in this repository", () => {
    expect(checkWorkflowSyntax(repositoryRoot)).toEqual([]);
  });

  it("catches an unclosed double quote in a command substitution", () => {
    // The exact shape that shipped: a jq command substitution whose double
    // quote is left unterminated. YAML accepts it; the shell does not.
    const violations = check(
      workflow([
        "      - name: Broken",
        "        run: |",
        "          set -euo pipefail",
        "          artifact_id=\"$(jq -er --arg name value \"",
        "            '.[0].id)",
        "          test \"\${artifact_id}\" = one",
      ]),
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("sample.yml:");
    expect(violations[0]).toContain("shell syntax error in run block");
  });

  it("catches a structural error such as a missing fi", () => {
    const violations = check(
      workflow([
        "      - name: Broken if",
        "        run: |",
        "          set -euo pipefail",
        "          if [ -n one ]; then",
        "            echo one",
      ]),
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("shell syntax error in run block");
  });

  it("follows the shell for an unterminated heredoc, which bash accepts", () => {
    // bash treats a heredoc that reaches end of file as terminated, so this is
    // not a syntax error and the gate must not invent one. Recorded here so the
    // gap is known rather than assumed.
    const violations = check(
      workflow([
        "      - name: Heredoc to end of file",
        "        run: |",
        "          python3 - <<'PY'",
        "          print('never closed')",
      ]),
    );

    expect(violations).toEqual([]);
  });

  it("accepts an inline command, a heredoc, and a multi-line block", () => {
    const violations = check(
      workflow([
        "      - name: Inline",
        "        run: echo one",
        "      - name: Heredoc",
        "        run: |",
        "          python3 - <<'PY'",
        "          print('closed')",
        "          PY",
        "      - name: Multiline",
        "        run: |",
        "          set -euo pipefail",
        "          value=\"$(printf %s one)\"",
        "          echo \"\${value}\"",
      ]),
    );

    expect(violations).toEqual([]);
  });
});
