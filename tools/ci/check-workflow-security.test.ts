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

function check(
  source: string,
  compatibilityDate = "2026-08-20",
  staticHeaders = `/*
  Strict-Transport-Security: max-age=31536000
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), clipboard-read=(), geolocation=(), gyroscope=(), microphone=(), payment=(), picture-in-picture=(), usb=()
  Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'none'
`,
): string[] {
  const root = mkdtempSync(join(tmpdir(), "intar-workflow-security-"));
  roots.push(root);
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "security.yml"), source);
  const nodeVersion = join(root, "apps/web/.node-version");
  mkdirSync(join(nodeVersion, ".."), { recursive: true });
  writeFileSync(nodeVersion, "24.17.0\n");
  for (const path of [
    "docs/wrangler.jsonc",
    "apps/web/wrangler.jsonc",
    "apps/web/wrangler.local.jsonc",
    "apps/web/workers/providers/gcp/wrangler.jsonc",
    "apps/web/workers/providers/hetzner/wrangler.jsonc",
    "tools/providers/live-capability-probe/wrangler.jsonc",
  ]) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `{ "compatibility_date": "${compatibilityDate}" }\n`);
  }
  const vitestConfig = join(root, "apps/web/vitest.workers.config.ts");
  mkdirSync(join(vitestConfig, ".."), { recursive: true });
  writeFileSync(
    vitestConfig,
    `export default { compatibilityDate: "${compatibilityDate}" };\n`,
  );
  for (const path of [
    "apps/web/public/_headers",
    "docs/public/_headers",
  ]) {
    const staticHeadersPath = join(root, path);
    mkdirSync(join(staticHeadersPath, ".."), { recursive: true });
    writeFileSync(staticHeadersPath, staticHeaders);
  }
  return checkWorkflowSecurity(root);
}

const pinnedCheckout =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7";
const pinnedTaiki =
  "taiki-e/install-action@ba47c86ac325773530516bb756137ac718732518 # v2";
const pinnedZig =
  "mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29 # v2";
const pinnedNode =
  "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6";
const pinnedBun =
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2";
const pinnedGo =
  "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6";

describe("workflow security policy", () => {
  it("accepts pinned actions, pinned tools, and Zig 0.16.0", () => {
    expect(
      check(`
name: Security
on: pull_request
jobs:
  security:
    runs-on: ubuntu-latest
    container:
      image: example.invalid/tool:v1.2.3@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    steps:
      - uses: ${pinnedCheckout}
      - uses: ${pinnedTaiki}
        with:
          tool: just@1.58.0,cargo-nextest@0.9.143,cargo-zigbuild@0.23.0,cargo-audit@0.22.2,wasm-pack@0.15.0
      - uses: ${pinnedZig}
        with:
          version: 0.16.0
      - uses: ${pinnedNode}
        with:
          node-version: 24.17.0
      - uses: ${pinnedBun}
        with:
          bun-version: 1.3.14
      - uses: ${pinnedGo}
        with:
          go-version: 1.27.0
      - run: rustup toolchain install 1.97.0 --profile minimal
      - run: rustup target add --toolchain 1.97.0 x86_64-unknown-linux-musl
      - run: go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.10
      - run: apt-get install --yes shellcheck=0.9.0-1
`),
    ).toEqual([]);
  });

  it("rejects mutable action references and missing tag comments", () => {
    const violations = check(`
jobs:
  security:
    container:
      image: example.invalid/tool:latest
    steps:
      - uses: actions/checkout@v7
      - uses: ${pinnedCheckout.slice(0, pinnedCheckout.indexOf(" #"))}
`);
    expect(violations.join("\n")).toContain(
      "must use a 40-character commit SHA",
    );
    expect(violations.join("\n")).toContain(
      "must retain its version tag comment",
    );
  });

  it("rejects pull_request_target and mutable tool installation", () => {
    const violations = check(`
on: pull_request_target
jobs:
  security:
    container:
      image: example.invalid/tool:latest
    steps:
      - uses: ${pinnedTaiki}
        with:
          tool: just,cargo-zigbuild@0.20.0,cargo-deny@stable
      - uses: ${pinnedZig}
        with:
          version: latest
      - uses: ${pinnedNode}
        with:
          node-version: latest
      - uses: ${pinnedBun}
        with:
          bun-version: latest
      - uses: ${pinnedGo}
        with:
          go-version: stable
      - run: rustup toolchain install stable --profile minimal
      - run: rustup target add wasm32-unknown-unknown
      - run: go install github.com/rhysd/actionlint/cmd/actionlint@latest
      - run: cargo install cargo-audit
      - run: |
          apt-get install --yes shellcheck=0.9.0-1 \\
            unzip
  shorthand-container:
    container: example.invalid/tool:latest
    steps: []
`);
    const output = violations.join("\n");
    expect(output).toContain("pull_request_target is forbidden");
    expect(output).toContain("taiki tool just must use an exact version");
    expect(output).toContain("taiki tool cargo-zigbuild must be 0.23.0");
    expect(output).toContain(
      "taiki tool cargo-deny@stable must use an exact version",
    );
    expect(output).toContain("Zig must be pinned to 0.16.0");
    expect(output).toContain("Rust toolchain must be pinned to 1.97.0");
    expect(output).toContain(
      "rustup target and component installs must use --toolchain 1.97.0",
    );
    expect(output).toContain("go install must use a literal exact version");
    expect(output).toContain(
      "cargo install must use an exact --version and --locked",
    );
    expect(output).toContain(
      "apt installs must pin every package with package=version",
    );
    expect(output).toContain(
      "container images must use an exact sha256 digest",
    );
    expect(output).toContain("Node must be pinned to 24.17.0");
    expect(output).toContain("Bun must be pinned to 1.3.14");
    expect(output).toContain("Go must be pinned to 1.27.0");
  });

  it("rejects Worker compatibility-date drift", () => {
    const output = check("on: workflow_dispatch\n", "2026-08-23").join("\n");
    expect(output).toContain(
      "docs/wrangler.jsonc: compatibility date must be 2026-08-20",
    );
  });

  it("rejects shorthand containers and multiline apt pin smuggling", () => {
    const output = check(`
jobs:
  shorthand:
    container: example.invalid/tool:latest
    steps:
      - run: |
          apt-get install --yes shellcheck=0.9.0-1 \\
            unzip
`).join("\n");
    expect(
      output.match(/container images must use an exact sha256 digest/gu),
    ).toHaveLength(1);
    expect(
      output.match(
        /apt installs must pin every package with package=version/gu,
      ),
    ).toHaveLength(1);
  });

  it("rejects static asset security-header drift", () => {
    const output = check(
      "on: workflow_dispatch\n",
      "2026-08-20",
      "/*\n",
    ).join("\n");
    expect(output).toContain("apps/web/public/_headers: missing");
    expect(output).toContain("docs/public/_headers: missing");
  });
});
