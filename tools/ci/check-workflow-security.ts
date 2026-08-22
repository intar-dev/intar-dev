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

      const use = /^(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(\S.*))?\s*$/u.exec(content);
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
    if (metadata.isFile() && (name.endsWith(".yml") || name.endsWith(".yaml"))) {
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
    if (!name || !version || version === "latest") {
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
