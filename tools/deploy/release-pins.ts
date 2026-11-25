#!/usr/bin/env bun
/**
 * The releases the website pins, resolved at deploy from the published GitHub
 * releases (deploy.yml, job deploy-web, step "Pin the published releases").
 *
 * A release is a candidate only when it is published, not a prerelease, its
 * tag's commit is on main, and every file pinned from it carries an
 * attestation that release.yml on main built it. Marking a release as a
 * prerelease, then deploying, holds it back: the pins fall back to the one
 * before. Newest is by version, never by list order.
 *
 *   - The scenario compiler: the newest intar-image-cli whose source compiles
 *     the source format HEAD's does (SOURCE_COMPILER_VERSION_V2), else the
 *     newest at all, which is what the site pinned before that format moved.
 *     SCENARIO_COMPILER_CLI_VERSION and SCENARIO_COMPILER_CLI_SHA256.
 *   - The desktop app: the newest intar-desktop, JUMPER_RELEASE_JSON. The
 *     installed app checks its download against this digest, which the
 *     attestation ties to main's release workflow.
 *   - Kino: per guest contract the tags were built for, and per architecture,
 *     the newest release whose artifact the registry stores is current and
 *     the stored one before it previous (KINO_PINS_JSON, with
 *     KINO_RELEASES_JSON), in the shape tools/deploy/kino-artifact.ts defines.
 *     Every contract keeps its entry, so a revision built for an older one
 *     still runs. A release whose artifact is not stored yet is skipped.
 *
 *   bun tools/deploy/release-pins.ts [--print] [--assume-stored]
 *
 * In GitHub Actions it writes the pins into DEPLOYMENT_CONFIG's vars. --print
 * prints them instead, and --assume-stored skips the registry query, for a
 * dry run on a developer's computer.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KINO_ARTIFACT_TYPE,
  type KinoArchitecture,
  type KinoPinPair,
  type KinoPins,
  type KinoReleases,
  kinoArtifact,
  parseKinoPins,
  pinnedKinoReleases,
} from "./kino-artifact.ts";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const COMPILER_PATH = "crates/intar-contracts/src/source.rs";
const CONTRACT_PATH = "crates/intar-contracts/src/guest.rs";
const COMPILER_RE = /^pub const SOURCE_COMPILER_VERSION_V2: &str = "([^"]*)";$/m;
const CONTRACT_RE = /^pub const GUEST_CONTRACT: u32 = ([1-9][0-9]*);$/m;
// ponytail: newest few Kino releases per contract only, so a deploy downloads
// a handful of archives; raise it if two stored releases ever lie further back.
const KINO_RELEASES_PER_CONTRACT = 4;
const ARCHITECTURES: KinoArchitecture[] = ["amd64", "arm64"];

/** What the resolver needs from GitHub, the registry and the runner. */
export interface Io {
  /** Every release: its tag and whether it is a draft or a prerelease. */
  releases(): { tag: string; draft: boolean; prerelease: boolean }[];
  /** The commit the tag names, and whether main holds it. */
  onMain(tag: string): boolean;
  /** A file of the tag's source, or null. */
  file(tag: string, path: string): string | null;
  /** Downloads the release's files with these names; returns the paths of those it has. */
  download(tag: string, names: string[]): Record<string, string>;
  /** Whether release.yml on main attested the file. */
  attested(path: string): boolean;
  /** The kino binary inside a release archive. */
  kinoBinary(archive: string): Uint8Array;
  /** Which of these Kino artifact digests the registry stores. */
  stored(digests: string[]): Set<string>;
  warn(message: string): void;
}

export interface Pins {
  SCENARIO_COMPILER_CLI_VERSION?: string;
  SCENARIO_COMPILER_CLI_SHA256?: string;
  JUMPER_RELEASE_JSON?: string;
  KINO_PINS_JSON?: string;
  KINO_RELEASES_JSON?: string;
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
}

/** The published, non-prerelease versions of a product, newest first. */
export function versionsOf(io: Io, prefix: string): string[] {
  return io.releases()
    .filter((release) => !release.draft && !release.prerelease && release.tag.startsWith(`${prefix}/v`))
    .map((release) => release.tag.slice(prefix.length + 2))
    .filter((version) => VERSION_RE.test(version))
    .sort((a, b) => compareVersions(b, a));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `<hex>  <name>` lines, the release's checksums file. */
function checksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/**
 * The release's files with these names, each checked against the checksums
 * file and its attestation; null, with a warning, when the release does not
 * qualify.
 */
function trustedFiles(io: Io, tag: string, checksumsName: string, names: string[]): Record<string, { path: string; sha256: string }> | null {
  if (!io.onMain(tag)) {
    io.warn(`${tag} is not on main; it is not pinned.`);
    return null;
  }
  const files = io.download(tag, [checksumsName, ...names]);
  if (files[checksumsName] === undefined) {
    io.warn(`${tag} has no ${checksumsName}; it is not pinned.`);
    return null;
  }
  const sums = checksums(readFileSync(files[checksumsName], "utf8"));
  const trusted: Record<string, { path: string; sha256: string }> = {};
  for (const name of names) {
    const path = files[name];
    const digest = path === undefined ? undefined : sha256(path);
    if (path === undefined || digest !== sums.get(name)) {
      io.warn(`${tag}'s ${name} does not match its checksums; it is not pinned.`);
      return null;
    }
    if (!io.attested(path)) {
      io.warn(`${tag}'s ${name} has no attestation from release.yml on main; it is not pinned.`);
      return null;
    }
    trusted[name] = { path, sha256: digest };
  }
  return trusted;
}

function compilerPins(io: Io, headCompiler: string | null): Pins {
  const versions = versionsOf(io, "image-cli");
  const compiles = (version: string) =>
    headCompiler !== null && COMPILER_RE.exec(io.file(`image-cli/v${version}`, COMPILER_PATH) ?? "")?.[1] === headCompiler;
  const pin = (version: string): Pins | null => {
    const archives = ["linux_amd64", "linux_arm64"];
    const files = trustedFiles(io, `image-cli/v${version}`, `intar-image-cli_${version}_checksums.txt`,
      archives.map((target) => `intar-image-cli_${version}_${target}.tar.gz`));
    if (files === null) return null;
    const digests = Object.fromEntries(archives.map((target) => [target, files[`intar-image-cli_${version}_${target}.tar.gz`]!.sha256]));
    return { SCENARIO_COMPILER_CLI_VERSION: version, SCENARIO_COMPILER_CLI_SHA256: JSON.stringify(digests) };
  };
  // Newest first, so the usual deploy reads one tag.
  let compiling = false;
  for (const version of versions) {
    if (!compiles(version)) continue;
    compiling = true;
    const pins = pin(version);
    if (pins !== null) return pins;
  }
  if (!compiling && versions.length > 0) {
    io.warn(`No intar-image-cli release compiles source format ${headCompiler ?? "(none)"} yet; the newest one stays pinned.`);
    for (const version of versions) {
      const pins = pin(version);
      if (pins !== null) return pins;
    }
  }
  if (versions.length > 0) throw new Error("No published intar-image-cli release qualifies; refusing to deploy without a compiler.");
  io.warn("No intar-image-cli release yet; the compiler descriptor answers 503.");
  return {};
}

function desktopPins(io: Io): Pins {
  for (const version of versionsOf(io, "desktop")) {
    const zip = `intar-desktop_${version}_macos_arm64.zip`;
    const files = trustedFiles(io, `desktop/v${version}`, `intar-desktop_${version}_checksums.txt`, [zip]);
    if (files === null) continue;
    return { JUMPER_RELEASE_JSON: JSON.stringify({ macos_arm64: { sha256: files[zip]!.sha256, version } }) };
  }
  if (versionsOf(io, "desktop").length > 0) throw new Error("No published intar-desktop release qualifies; refusing to deploy without one.");
  io.warn("No intar-desktop release yet; installed apps are offered none.");
  return {};
}

interface KinoCandidate { version: string; contract: string; architecture: KinoArchitecture; digest: string; sha256: string }

function kinoPins(io: Io): Pins {
  const byContract = new Map<string, string[]>();
  for (const version of versionsOf(io, "kino")) {
    const contract = CONTRACT_RE.exec(io.file(`kino/v${version}`, CONTRACT_PATH) ?? "")?.[1];
    if (contract === undefined) continue;
    const versions = byContract.get(contract) ?? [];
    if (versions.length < KINO_RELEASES_PER_CONTRACT) byContract.set(contract, [...versions, version]);
  }
  // Newest first, until each architecture has a current and a previous
  // stored artifact: each release costs a download and two attestation checks.
  const candidates: KinoCandidate[] = [];
  const stored = new Set<string>();
  for (const [contract, versions] of byContract) {
    for (const version of versions) {
      const enough = ARCHITECTURES.every((architecture) =>
        candidates.filter((c) => c.contract === contract && c.architecture === architecture && stored.has(c.digest)).length >= 2);
      if (enough) break;
      const names = Object.fromEntries(ARCHITECTURES.map((arch) => [arch, `kino_${version}_linux_${arch}.tar.gz`]));
      const files = trustedFiles(io, `kino/v${version}`, `kino_${version}_checksums.txt`, Object.values(names));
      if (files === null) continue;
      const built = ARCHITECTURES.map((architecture) => {
        const archive = files[names[architecture]!]!;
        const digest = kinoArtifact(io.kinoBinary(archive.path), version, Number(contract), architecture).digest;
        return { version, contract, architecture, digest, sha256: archive.sha256 };
      });
      candidates.push(...built);
      for (const digest of io.stored(built.map((candidate) => candidate.digest))) stored.add(digest);
    }
  }
  const pins: KinoPins = {};
  const releases: KinoReleases = {};
  for (const contract of byContract.keys()) {
    const pair = (architecture: KinoArchitecture): KinoPinPair | null => {
      const ready = candidates.filter((c) => c.contract === contract && c.architecture === architecture && stored.has(c.digest));
      for (const skipped of candidates.filter((c) => c.contract === contract && c.architecture === architecture && !stored.has(c.digest))) {
        if (ready.length === 0 || compareVersions(skipped.version, ready[0]!.version) > 0) {
          io.warn(`The registry stores no ${architecture} artifact of kino ${skipped.version} yet; it is not pinned.`);
        }
      }
      if (ready.length === 0) return null;
      releases[contract] = { ...releases[contract], [architecture]: { version: ready[0]!.version, sha256: ready[0]!.sha256, digest: ready[0]!.digest } };
      return { current: ready[0]!.digest, previous: ready[1]?.digest ?? null };
    };
    const amd64 = pair("amd64");
    if (amd64 === null) continue;
    const arm64 = pair("arm64");
    pins[contract] = arm64 === null ? amd64 : { ...amd64, arm64 };
  }
  if (Object.keys(pins).length === 0) {
    // Releases exist but none is stored and attested among the newest: losing
    // every pin would stop all VM placement, so the deploy stops instead.
    if (byContract.size > 0) throw new Error("No Kino release qualifies; refusing to deploy without a Kino pin. Store one with release.yml's kino job.");
    io.warn("No Kino release yet; no VM is placed until one is pinned.");
    return {};
  }
  // Through the parser, so the Worker reads exactly what the deploy checked.
  const parsed = parseKinoPins(JSON.stringify(pins));
  return { KINO_PINS_JSON: JSON.stringify(parsed), KINO_RELEASES_JSON: JSON.stringify(pinnedKinoReleases(parsed, releases)) };
}

/** Every pin, from the releases and HEAD's own source. */
export function resolvePins(io: Io, head: { compiler: string | null }): Pins {
  return { ...compilerPins(io, head.compiler), ...desktopPins(io), ...kinoPins(io) };
}

// A command's output, or null when it failed with a definitive "not found"
// (`notFound` matches its stderr). Any other failure throws, so a GitHub or
// network error fails the deploy instead of pinning an older release.
function run(command: string, args: string[], notFound?: RegExp): string | null {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  if (notFound?.test(result.stderr)) return null;
  throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
}
const HTTP_404 = /HTTP 404/;

function liveIo(repository: string, assumeStored: boolean): Io {
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "release-pins-"));
  let releases: ReturnType<Io["releases"]> | undefined;
  return {
    releases() {
      releases ??= (JSON.parse(run("gh", ["release", "list", "--repo", repository, "--limit", "1000", "--json", "tagName,isDraft,isPrerelease"])!) as
        { tagName: string; isDraft: boolean; isPrerelease: boolean }[])
        .map((release) => ({ tag: release.tagName, draft: release.isDraft, prerelease: release.isPrerelease }));
      return releases;
    },
    onMain(tag) {
      const sha = run("gh", ["api", `repos/${repository}/commits/${encodeURIComponent(tag)}`, "--jq", ".sha"])!.trim();
      const status = run("gh", ["api", `repos/${repository}/compare/main...${sha}`, "--jq", ".status"])!.trim();
      return status === "behind" || status === "identical";
    },
    file(tag, path) {
      return run("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repository}/contents/${path}?ref=${encodeURIComponent(tag)}`], HTTP_404);
    },
    download(tag, names) {
      const dir = mkdtempSync(join(work, "release-"));
      // A file the release lacks is left out, and the release skipped.
      const assets = new Set(run("gh", ["release", "view", tag, "--repo", repository, "--json", "assets", "--jq", ".assets[].name"])!.split("\n"));
      const present = names.filter((name) => assets.has(name));
      if (present.length > 0) {
        run("gh", ["release", "download", tag, "--repo", repository, "--dir", dir, ...present.flatMap((name) => ["--pattern", name])]);
      }
      return Object.fromEntries(present.map((name) => [name, join(dir, name)]));
    },
    attested(path) {
      return run("gh", [
        "attestation", "verify", path, "--repo", repository,
        "--signer-workflow", `${repository}/.github/workflows/release.yml`, "--source-ref", "refs/heads/main",
      ], HTTP_404) !== null;
    },
    kinoBinary(archive) {
      const dir = mkdtempSync(join(work, "kino-"));
      run("tar", ["-xzf", archive, "-C", dir, "./kino"]);
      return readFileSync(join(dir, "kino"));
    },
    stored(digests) {
      if (assumeStored) return new Set(digests);
      return storedKinoArtifacts(digests);
    },
    warn(message) {
      console.error(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    },
  };
}

/** Read-only: the query names only literal digests kinoArtifact computed. */
function storedKinoArtifacts(digests: string[]): Set<string> {
  const query = (sql: string) => {
    const response = run("curl", [
      "--fail-with-body", "--silent", "--show-error", "--request", "POST",
      "--header", `Authorization: Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "--header", "Content-Type: application/json",
      "--data-binary", JSON.stringify({ sql, params: [] }),
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.DATABASE_ID}/query`,
    ])!;
    const body = JSON.parse(response) as { success: boolean; result: { success: boolean; results: Record<string, string>[] }[] };
    if (!body.success || !body.result[0]?.success) throw new Error("the D1 query failed");
    return body.result[0].results;
  };
  if (query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_manifests'").length === 0) {
    return new Set();
  }
  for (const digest of digests) if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`not a digest: ${digest}`);
  const list = digests.map((digest) => `'${digest}'`).join(",");
  return new Set(query(
    `SELECT digest FROM registry_manifests WHERE artifact_type = '${KINO_ARTIFACT_TYPE}' AND digest IN (${list})`,
  ).map((row) => row.digest!));
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? "intar-dev/intar-dev";
  const io = liveIo(repository, process.argv.includes("--assume-stored"));
  const compiler = COMPILER_RE.exec(readFileSync(COMPILER_PATH, "utf8"))?.[1] ?? null;
  const pins = resolvePins(io, { compiler });
  if (process.argv.includes("--print")) {
    console.log(JSON.stringify(pins, null, 2));
  } else {
    const path = process.env.DEPLOYMENT_CONFIG;
    if (!path) throw new Error("DEPLOYMENT_CONFIG names no deployment configuration");
    const config = JSON.parse(readFileSync(path, "utf8")) as { vars?: Record<string, string> };
    config.vars = { ...config.vars, ...pins };
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    const summary = Object.entries(pins).map(([name, value]) => `${name}: ${value}`).join("\n");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Pinned releases:\n${summary}\n`);
    console.log(summary);
  }
}
