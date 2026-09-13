#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const WORKFLOW_DIRECTORY = ".github/workflows";

/**
 * Parse every shell block in every workflow with the shell itself.
 *
 * A workflow can be valid YAML and still carry a shell script that the shell
 * cannot parse. String assertions and YAML parsing both miss that, so this
 * gate feeds each "run:" body to `bash -n` and reports what the shell says.
 */
export function checkWorkflowSyntax(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const workflowRoot = resolve(repositoryRoot, WORKFLOW_DIRECTORY);
  for (const workflowPath of workflowPaths(workflowRoot)) {
    const source = readFileSync(workflowPath, "utf8");
    const name = relative(repositoryRoot, workflowPath);
    for (const block of shellBlocks(source)) {
      const result = spawnSync("bash", ["-n"], {
        encoding: "utf8",
        input: block.body,
      });
      if (result.error) {
        violations.push(`${name}:${block.line}: bash is unavailable: ${result.error.message}`);
        continue;
      }
      if (result.status === 0) continue;
      const detail = (result.stderr ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 2)
        .join(" ");
      violations.push(
        `${name}:${block.line}: shell syntax error in run block: ${detail}`,
      );
    }
  }
  return violations;
}

interface ShellBlock {
  line: number;
  body: string;
}

/**
 * Collect "run:" bodies by indentation. The body of a literal block is every
 * following line that is indented deeper than the "run:" key itself.
 */
function shellBlocks(source: string): ShellBlock[] {
  const lines = source.split("\n");
  const blocks: ShellBlock[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const keyIndent = match[1]?.length ?? 0;
    const inline = (match[2] ?? "").trim();
    if (inline.length > 0 && inline !== "|" && inline !== ">" && inline !== "|-") {
      blocks.push({ line: index + 1, body: inline + "\n" });
      continue;
    }
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      if (candidate.trim().length === 0) {
        body.push("");
        continue;
      }
      const indent = candidate.length - candidate.trimStart().length;
      if (indent <= keyIndent) break;
      body.push(candidate);
    }
    // A workflow writes the block one level deeper than its key; strip the
    // common indentation so the shell sees the script as written.
    blocks.push({ line: index + 1, body: dedent(body) });
  }
  return blocks;
}

function dedent(lines: readonly string[]): string {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const shortest = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shortest)).join("\n") + "\n";
}

function workflowPaths(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(root, name));
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const violations = checkWorkflowSyntax(repositoryRoot);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation);
    }
    console.error(`Workflow shell syntax violations: ${violations.length}`);
    process.exit(1);
  }
  process.stdout.write("Workflow shell syntax passed\n");
}

