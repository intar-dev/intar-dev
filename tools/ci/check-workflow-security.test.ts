import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import { checkWorkflowSecurity } from "./check-workflow-security";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function check(source: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "intar-workflow-security-"));
  roots.push(root);
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "security.yml"), source);
  return checkWorkflowSecurity(root);
}

const pinnedCheckout =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7";
const pinnedTaiki =
  "taiki-e/install-action@ba47c86ac325773530516bb756137ac718732518 # v2";
const pinnedZig =
  "mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29 # v2";

describe("workflow security policy", () => {
  it("accepts pinned actions, pinned tools, and Zig 0.16.0", () => {
    expect(
      check(`
name: Security
on: pull_request
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - uses: ${pinnedTaiki}
        with:
          tool: just@1.58.0,cargo-nextest@0.9.143,cargo-zigbuild@0.23.0,cargo-audit@0.22.2,wasm-pack@0.15.0
      - uses: ${pinnedZig}
        with:
          version: 0.16.0
`),
    ).toEqual([]);
  });

  it("rejects mutable action references and missing tag comments", () => {
    const violations = check(`
jobs:
  security:
    steps:
      - uses: actions/checkout@v7
      - uses: ${pinnedCheckout.slice(0, pinnedCheckout.indexOf(" #"))}
`);
    expect(violations.join("\n")).toContain("must use a 40-character commit SHA");
    expect(violations.join("\n")).toContain("must retain its version tag comment");
  });

  it("rejects pull_request_target and mutable tool installation", () => {
    const violations = check(`
on: pull_request_target
jobs:
  security:
    steps:
      - uses: ${pinnedTaiki}
        with:
          tool: just,cargo-zigbuild@0.20.0
      - uses: ${pinnedZig}
        with:
          version: latest
`);
    const output = violations.join("\n");
    expect(output).toContain("pull_request_target is forbidden");
    expect(output).toContain("taiki tool just must use an exact version");
    expect(output).toContain("taiki tool cargo-zigbuild must be 0.23.0");
    expect(output).toContain("Zig must be pinned to 0.16.0");
  });
});
