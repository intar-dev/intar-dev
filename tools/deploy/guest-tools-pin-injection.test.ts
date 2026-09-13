import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const deployWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/website-deploy.yml"),
  "utf8",
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PIN = {
  schema_version: 1,
  bootstrap_abi: 2,
  tools_disk_sha256: "a".repeat(64),
  tools_disk_size_bytes: 67108864,
  compressed_disk_sha256: "b".repeat(64),
  compressed_disk_size_bytes: 2468611,
  kino_sha256: "c".repeat(64),
  kino_size_bytes: 5675920,
};

/**
 * The exact jq assignment the deploy workflow applies to the generated Worker
 * config, read from the workflow so the test cannot drift from what ships.
 */
function injectionExpression(): string {
  // Capture the whole single-quoted jq program, not just its right-hand side,
  // so the test applies the same assignment path the workflow applies.
  const match =
    /'([^']*[.]vars[.]SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON = [^']*)'/u.exec(
      deployWorkflow,
    );
  if (!match?.[1]) throw new Error("pin assignment expression not found");
  return match[1].trim();
}

/**
 * The exact assertion jq program the workflow runs after injecting, so the
 * test executes the shipped guard and not a copy of it.
 */
function assertionExpression(): string {
  const marker = "jq -e --slurpfile pin ";
  const start = deployWorkflow.indexOf(marker);
  if (start < 0) throw new Error("pin assertion not found");
  const body = deployWorkflow.slice(start);
  const open = body.indexOf("'", marker.length);
  // The program ends at the closing quote before the config path argument.
  const close = body.indexOf("' \"", open + 1);
  if (open < 0 || close < 0) throw new Error("pin assertion body not found");
  return body.slice(open + 1, close).trim();
}

/**
 * The Worker contract, mirrored from apps/web/src/lib/scenario-guest-tools.ts:
 * the variable must be a string, and that string is then parsed. The app suite
 * owns the full reader test; this one covers the wire type that broke
 * production, where an object was stored and every start failed closed.
 */
function acceptsStoredValue(stored: unknown): boolean {
  return typeof stored === "string" && stored.trim().length > 0;
}

function applyInjection(expression: string, pin: unknown) {
  const root = mkdtempSync(join(tmpdir(), "intar-pin-injection-"));
  roots.push(root);
  const pinFile = join(root, "release-static-pin.json");
  writeFileSync(pinFile, JSON.stringify(pin));
  const result = spawnSync("jq", ["--slurpfile", "pin", pinFile, expression], {
    encoding: "utf8",
    input: JSON.stringify({ vars: {} }),
  });
  if (result.status !== 0) {
    throw new Error("jq failed: " + (result.stderr ?? ""));
  }
  return JSON.parse(result.stdout) as { vars: Record<string, unknown> };
}

function assertionPasses(pin: unknown, stored: unknown): boolean {
  const root = mkdtempSync(join(tmpdir(), "intar-pin-assert-"));
  roots.push(root);
  const pinFile = join(root, "release-static-pin.json");
  writeFileSync(pinFile, JSON.stringify(pin));
  const configFile = join(root, "wrangler.json");
  writeFileSync(
    configFile,
    JSON.stringify({ vars: { SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON: stored } }),
  );
  const result = spawnSync(
    "jq",
    ["-e", "--slurpfile", "pin", pinFile, assertionExpression(), configFile],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

describe("guest-tools pin injection writes the string wire form", () => {
  it("stores a JSON string that parses back to the exact verified pin", () => {
    const config = applyInjection(injectionExpression(), PIN);
    const stored = config.vars.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON;

    expect(typeof stored).toBe("string");
    expect(acceptsStoredValue(stored)).toBe(true);
    expect(JSON.parse(stored as string)).toEqual(PIN);
    expect(assertionPasses(PIN, stored)).toBe(true);
  });

  it("rejects the object wire form that broke production", () => {
    expect(acceptsStoredValue(PIN)).toBe(false);
    expect(assertionPasses(PIN, PIN)).toBe(false);
  });

  it("rejects a string that is not the verified pin", () => {
    const other = { ...PIN, kino_sha256: "d".repeat(64) };
    const stored = JSON.stringify(other);
    expect(acceptsStoredValue(stored)).toBe(true);
    expect(assertionPasses(PIN, stored)).toBe(false);
  });
});
