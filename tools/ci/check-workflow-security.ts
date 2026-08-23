#!/usr/bin/env bun

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WORKFLOW_DIRECTORY = ".github/workflows";
const PINNED_TAIKI_TOOLS = new Map([
  ["just", "1.58.0"],
  ["cargo-nextest", "0.9.143"],
  ["cargo-zigbuild", "0.23.0"],
  ["cargo-audit", "0.22.2"],
  ["wasm-pack", "0.15.0"],
]);
const SHA = /^[0-9a-f]{40}$/u;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const RUST_TOOLCHAIN = "1.97.0";
const NODE_VERSION = "24.17.0";
const BUN_VERSION = "1.3.14";
const GO_VERSION = "1.27.0";
// Miniflare 5.20260820.0-alpha is the newest published runtime on 2026-08-23
// and rejects 2026-08-23 as a future compatibility date. Keep every Worker
// and its test pool on the newest supported date until that runtime advances.
const WORKER_COMPATIBILITY_DATE = "2026-08-20";
const WORKER_COMPATIBILITY_FILES = [
  "apps/web/wrangler.jsonc",
  "apps/web/wrangler.local.jsonc",
  "apps/web/workers/providers/gcp/wrangler.jsonc",
  "apps/web/workers/providers/hetzner/wrangler.jsonc",
  "tools/providers/live-capability-probe/wrangler.jsonc",
  "apps/web/vitest.workers.config.ts",
] as const;

export function checkWorkflowSecurity(repositoryRoot: string): string[] {
  const workflowRoot = resolve(repositoryRoot, WORKFLOW_DIRECTORY);
  const violations: string[] = [];

  for (const workflowPath of workflowPaths(workflowRoot)) {
    const source = readFileSync(workflowPath, "utf8");
    const name = relative(repositoryRoot, workflowPath);
    const lines = source.split("\n");
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      const content = line.trim();
      if (!content || content.startsWith("#")) continue;
      if (content.includes("pull_request_target")) {
        violations.push(
          `${name}:${lineNumber}: pull_request_target is forbidden`,
        );
      }
      checkInstalledToolVersions(content, name, lineNumber, violations);
      const containerImage = /^image:\s*([^\s#]+)\s*$/u.exec(content)?.[1];
      if (containerImage && !/@sha256:[0-9a-f]{64}$/u.test(containerImage)) {
        violations.push(
          `${name}:${lineNumber}: container images must use an exact sha256 digest`,
        );
      }
      const shorthandContainer = /^container:\s*([^\s#]+)\s*$/u.exec(
        content,
      )?.[1];
      if (
        shorthandContainer &&
        !/@sha256:[0-9a-f]{64}$/u.test(shorthandContainer)
      ) {
        violations.push(
          `${name}:${lineNumber}: container images must use an exact sha256 digest`,
        );
      }

      const use = /^(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(\S.*))?\s*$/u.exec(
        content,
      );
      if (!use) continue;
      const reference = use[1];
      const tagComment = use[2];
      if (!reference) continue;
      if (reference.startsWith("./")) continue;

      const separator = reference.lastIndexOf("@");
      if (separator <= 0) {
        violations.push(
          `${name}:${lineNumber}: external action must use a commit SHA`,
        );
        continue;
      }
      const action = reference.slice(0, separator);
      const revision = reference.slice(separator + 1);
      if (!SHA.test(revision)) {
        violations.push(
          `${name}:${lineNumber}: ${action} must use a 40-character commit SHA`,
        );
      }
      if (!tagComment || !/^v[0-9][0-9A-Za-z._-]*$/u.test(tagComment)) {
        violations.push(
          `${name}:${lineNumber}: ${action} must retain its version tag comment`,
        );
      }
      if (action === "taiki-e/install-action") {
        checkTaikiToolVersions(lines, index, name, violations);
      }
      if (action === "mlugg/setup-zig") {
        checkZigVersion(lines, index, name, violations);
      }
      if (action === "actions/setup-node") {
        const version = stepProperty(lines, index, "node-version");
        const versionFile = stepProperty(lines, index, "node-version-file");
        if (
          version !== NODE_VERSION &&
          versionFile !== "apps/web/.node-version"
        ) {
          violations.push(
            `${name}:${lineNumber}: Node must be pinned to ${NODE_VERSION} or apps/web/.node-version`,
          );
        }
      }
      if (
        action === "oven-sh/setup-bun" &&
        stepProperty(lines, index, "bun-version") !== BUN_VERSION
      ) {
        violations.push(
          `${name}:${lineNumber}: Bun must be pinned to ${BUN_VERSION}`,
        );
      }
      if (
        action === "actions/setup-go" &&
        stepProperty(lines, index, "go-version") !== GO_VERSION
      ) {
        violations.push(
          `${name}:${lineNumber}: Go must be pinned to ${GO_VERSION}`,
        );
      }
    }
  }
  const nodeVersionFile = resolve(repositoryRoot, "apps/web/.node-version");
  try {
    if (readFileSync(nodeVersionFile, "utf8").trim() !== NODE_VERSION) {
      violations.push(
        `apps/web/.node-version: Node must be pinned to ${NODE_VERSION}`,
      );
    }
  } catch {
    violations.push(
      "apps/web/.node-version: pinned Node version file is missing",
    );
  }
  for (const relativePath of WORKER_COMPATIBILITY_FILES) {
    const path = resolve(repositoryRoot, relativePath);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      violations.push(
        `${relativePath}: required Worker configuration is missing`,
      );
      continue;
    }
    const property = relativePath.endsWith(".ts")
      ? "compatibilityDate"
      : '"compatibility_date"';
    const expected = `${property}: "${WORKER_COMPATIBILITY_DATE}"`;
    if (!source.includes(expected)) {
      violations.push(
        `${relativePath}: compatibility date must be ${WORKER_COMPATIBILITY_DATE}`,
      );
    }
  }
  const staticHeadersPath = "apps/web/public/_headers";
  let staticHeaders: string;
  try {
    staticHeaders = readFileSync(
      resolve(repositoryRoot, staticHeadersPath),
      "utf8",
    );
  } catch {
    violations.push(
      `${staticHeadersPath}: static asset security headers are missing`,
    );
    staticHeaders = "";
  }
  for (const header of [
    "Strict-Transport-Security: max-age=31536000",
    "X-Frame-Options: DENY",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer",
    "Permissions-Policy: accelerometer=(), autoplay=(), camera=(), clipboard-read=(), geolocation=(), gyroscope=(), microphone=(), payment=(), picture-in-picture=(), usb=()",
    "Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  ]) {
    if (!staticHeaders.includes(header)) {
      violations.push(`${staticHeadersPath}: missing ${header}`);
    }
  }
  return violations;
}

function workflowPaths(root: string): string[] {
  const paths: string[] = [];
  visit(root, paths);
  return paths.sort();
}

function visit(directory: string, paths: string[]): void {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      visit(path, paths);
      continue;
    }
    if (
      metadata.isFile() &&
      (name.endsWith(".yml") || name.endsWith(".yaml"))
    ) {
      paths.push(path);
    }
  }
}

function checkTaikiToolVersions(
  lines: readonly string[],
  useLineIndex: number,
  workflowName: string,
  violations: string[],
): void {
  const tool = stepProperty(lines, useLineIndex, "tool");
  if (!tool) {
    violations.push(
      `${workflowName}:${useLineIndex + 1}: taiki-e/install-action must declare exact tool versions`,
    );
    return;
  }
  for (const entry of tool.split(",").map((value) => value.trim())) {
    const separator = entry.lastIndexOf("@");
    const name = separator > 0 ? entry.slice(0, separator) : entry;
    const version = separator > 0 ? entry.slice(separator + 1) : "";
    if (!name || !EXACT_VERSION.test(version)) {
      violations.push(
        `${workflowName}:${useLineIndex + 1}: taiki tool ${entry} must use an exact version`,
      );
      continue;
    }
    const expectedVersion = PINNED_TAIKI_TOOLS.get(name);
    if (expectedVersion && version !== expectedVersion) {
      violations.push(
        `${workflowName}:${useLineIndex + 1}: taiki tool ${name} must be ${expectedVersion}`,
      );
    }
  }
}

function checkInstalledToolVersions(
  content: string,
  workflowName: string,
  lineNumber: number,
  violations: string[],
): void {
  if (content.includes("rustup toolchain install")) {
    const match = /rustup\s+toolchain\s+install\s+(\S+)/u.exec(content);
    if (match?.[1] !== RUST_TOOLCHAIN) {
      violations.push(
        `${workflowName}:${lineNumber}: Rust toolchain must be pinned to ${RUST_TOOLCHAIN}`,
      );
    }
  }
  if (/rustup\s+(?:target|component)\s+add\b/u.test(content)) {
    const match = /--toolchain\s+(\S+)/u.exec(content);
    if (match?.[1] !== RUST_TOOLCHAIN) {
      violations.push(
        `${workflowName}:${lineNumber}: rustup target and component installs must use --toolchain ${RUST_TOOLCHAIN}`,
      );
    }
  }

  const goInstall = /\bgo\s+install\s+["']?([^\s"']+)["']?/u.exec(content);
  if (goInstall?.[1]) {
    const separator = goInstall[1].lastIndexOf("@");
    const version = separator > 0 ? goInstall[1].slice(separator + 1) : "";
    if (!EXACT_VERSION.test(version)) {
      violations.push(
        `${workflowName}:${lineNumber}: go install must use a literal exact version`,
      );
    }
  }

  if (/\bcargo\s+install\b/u.test(content)) {
    const version = /--version\s+["']?([^\s"']+)/u.exec(content)?.[1] ?? "";
    if (!EXACT_VERSION.test(version) || !/\s--locked(?:\s|$)/u.test(content)) {
      violations.push(
        `${workflowName}:${lineNumber}: cargo install must use an exact --version and --locked`,
      );
    }
  }

  const aptInstall = /\bapt(?:-get)?\s+install\b([^;&|]*)/u.exec(content);
  if (aptInstall) {
    const packages = (aptInstall[1] ?? "")
      .trim()
      .split(/\s+/u)
      .filter((value) => value && !value.startsWith("-") && value !== "\\");
    if (
      content.endsWith("\\") ||
      packages.length === 0 ||
      packages.some((value) => !/^[A-Za-z0-9.+-]+=[^\s=]+$/u.test(value))
    ) {
      violations.push(
        `${workflowName}:${lineNumber}: apt installs must pin every package with package=version`,
      );
    }
  }
}

function checkZigVersion(
  lines: readonly string[],
  useLineIndex: number,
  workflowName: string,
  violations: string[],
): void {
  const version = stepProperty(lines, useLineIndex, "version");
  if (version !== "0.16.0") {
    violations.push(
      `${workflowName}:${useLineIndex + 1}: Zig must be pinned to 0.16.0`,
    );
  }
}

function stepProperty(
  lines: readonly string[],
  useLineIndex: number,
  property: string,
): string | undefined {
  const useIndent = indentation(lines[useLineIndex] ?? "");
  for (let index = useLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const content = line.trim();
    if (!content || content.startsWith("#")) continue;
    const indent = indentation(line);
    if (indent <= useIndent && content.startsWith("- ")) break;
    if (indent < useIndent) continue;
    const match = new RegExp(`^${property}:\\s*(.+?)\\s*$`, "u").exec(content);
    if (!match?.[1]) continue;
    return unquote(match[1]);
  }
  return undefined;
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const violations = checkWorkflowSecurity(repositoryRoot);
  if (violations.length > 0) {
    process.stderr.write(
      `Workflow security policy violations:\n${violations.map((value) => `- ${value}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write("Workflow security policy passed\n");
}
