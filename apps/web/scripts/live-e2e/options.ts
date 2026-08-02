import type { Options, RequiredImage } from "./types";

export function parseOptions(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
): Options {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    printHelp();
    process.exit(0);
  }
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;
    if (booleanFlags.has(key)) {
      if (inlineValue !== null) {
        throw new Error(`--${key} does not accept a value`);
      }
      flags.add(key);
      continue;
    }
    if (!valueOptions.has(key)) {
      throw new Error(`unknown option: --${key}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    if (inlineValue === null) {
      index += 1;
    }
    const list = values.get(key) ?? [];
    list.push(value);
    values.set(key, list);
  }

  if (env.INTAR_LIVE_CROSS_RUN_SCENARIO_ID) {
    throw new Error(
      "INTAR_LIVE_CROSS_RUN_SCENARIO_ID was removed: cross-run proof requires a multi-session harness with two authenticated users and concurrent runs on the same agent host",
    );
  }

  const baseUrl = last(values, "base-url") ?? env.INTAR_LIVE_BASE_URL ?? "";
  const cookie = last(values, "cookie") ?? env.INTAR_LIVE_COOKIE ?? "";
  const scenarioId =
    last(values, "scenario") ?? env.INTAR_LIVE_SCENARIO_ID ?? "broken-nginx";
  const hostId = last(values, "host") ?? env.INTAR_LIVE_HOST_ID ?? null;
  const buildRev =
    last(values, "build-rev") ?? env.INTAR_LIVE_BUILD_REV ?? null;
  const publishToken =
    last(values, "publish-token") ?? env.INTAR_IMAGE_PUBLISH_TOKEN ?? null;
  const manifestPaths = [
    ...splitEnvList(env.INTAR_LIVE_MANIFESTS),
    ...(values.get("manifest") ?? []),
  ];
  const imageSpecs = [
    ...splitEnvList(env.INTAR_LIVE_IMAGES),
    ...(values.get("image") ?? []),
  ];
  const artifactSpecs = [
    ...splitEnvList(env.INTAR_LIVE_ARTIFACTS),
    ...(values.get("artifact") ?? []),
  ];

  if (!baseUrl) {
    throw new Error("--base-url or INTAR_LIVE_BASE_URL is required");
  }
  if (!cookie) {
    throw new Error("--cookie or INTAR_LIVE_COOKIE is required");
  }

  return {
    baseUrl,
    cookie,
    scenarioId,
    hostId,
    buildRev,
    publishToken,
    manifestPaths,
    imagePathsByVmName: parseImageSpecs(imageSpecs),
    artifactPathsBySha: parseArtifactSpecs(artifactSpecs),
    skipPublish: flags.has("skip-publish"),
    skipTeardown: flags.has("skip-teardown"),
    skipTerminalProbe: flags.has("skip-terminal-probe"),
    allowNoArtifacts: flags.has("allow-no-artifacts"),
    waitCacheMs: parseMs(last(values, "wait-cache-ms"), 180_000),
    waitBuildMs: parseMs(last(values, "wait-build-ms"), 900_000),
    waitReadyMs: parseMs(last(values, "wait-ready-ms"), 480_000),
    waitCompleteMs: parseMs(last(values, "wait-complete-ms"), 240_000),
    pollMs: parseMs(last(values, "poll-ms"), 100),
    warmStartBudgetMs: parseMs(last(values, "warm-start-ms"), 10_000),
    terminalProbeTimeoutMs: parseMs(
      last(values, "terminal-probe-timeout-ms"),
      30_000,
    ),
    forbiddenIps:
      values.get("forbidden-ip") ?? splitEnvList(env.INTAR_LIVE_FORBIDDEN_IPS),
  };
}

const booleanFlags = new Set([
  "skip-publish",
  "skip-teardown",
  "skip-terminal-probe",
  "allow-no-artifacts",
]);

const valueOptions = new Set([
  "base-url",
  "cookie",
  "scenario",
  "host",
  "build-rev",
  "publish-token",
  "manifest",
  "image",
  "artifact",
  "forbidden-ip",
  "wait-cache-ms",
  "wait-build-ms",
  "wait-ready-ms",
  "wait-complete-ms",
  "poll-ms",
  "warm-start-ms",
  "terminal-probe-timeout-ms",
]);

export function parseImageSpecs(specs: string[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`image spec must be vmName=path: ${spec}`);
    }
    images.set(spec.slice(0, eq), spec.slice(eq + 1));
  }
  return images;
}

export function parseArtifactSpecs(specs: string[]): Map<string, string> {
  const artifacts = new Map<string, string>();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`artifact spec must be sha256=path: ${spec}`);
    }
    const sha256 = spec.slice(0, eq).trim().toLowerCase();
    if (!isSha256Hex(sha256)) {
      throw new Error(`artifact spec has invalid sha256: ${spec}`);
    }
    artifacts.set(sha256, spec.slice(eq + 1));
  }
  return artifacts;
}

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function isImageArchitecture(
  value: unknown,
): value is RequiredImage["image_key"]["arch"] {
  return value === "x86_64" || value === "aarch64";
}

export function parseMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid millisecond value: ${raw}`);
  }
  return parsed;
}

export function last(
  values: Map<string, string[]>,
  key: string,
): string | undefined {
  return values.get(key)?.at(-1);
}

export function splitEnvList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function printHelp(): void {
  console.log(`Usage:
  bun run e2e:live -- --base-url https://intar.dev --cookie 'better-auth.session_token=...' \\
    --manifest ../dist/broken-nginx-webserver-amd64.raw.zst.manifest.json

Required unless skipped:
  --base-url URL                 Deployed website origin.
  --cookie COOKIE                Authenticated admin browser cookie header.
  --publish-token TOKEN          Registry publish token. Defaults to INTAR_IMAGE_PUBLISH_TOKEN.
  --manifest PATH                Builder manifest JSON. Repeat for multi-VM scenarios.

Useful options:
  --scenario ID                  Scenario to start. Defaults to broken-nginx.
  --host HOST_ID                 Pin the run to a specific host.
  --build-rev REV                Wait for admin image build rows for this bundle revision.
  --image VM=PATH                Override inferred raw.zst path for a VM manifest.
  --artifact SHA=PATH            Override inferred kernel/initrd boot artifact path.
  --forbidden-ip IP              Guest-side IP that must be unreachable. Repeatable.
  --skip-publish                 Assume catalog/cache desired state is already published.
  --skip-terminal-probe          Only create Stargate routes; do not open the terminal websocket.
  --skip-teardown                Leave the run active for manual inspection.
  --allow-no-artifacts           Do not fail if teardown produces no artifacts.
  --wait-build-ms MS             Builder queue timeout. Defaults to 900000.
  --wait-ready-ms MS             Run readiness timeout. Defaults to 480000.
  --warm-start-ms MS             Click-to-terminal budget. Defaults to 10000.
`);
}
