#!/usr/bin/env bun
/**
 * The Kino artifact of a Kino release, and the Kino pin the website deploys.
 *
 * A Kino artifact is an OCI manifest with `artifactType`
 * `application/vnd.intar.kino.v1`, a `{guest_contract, version}` config and
 * the static binary as its one layer. Its bytes depend only on the binary,
 * the version and the contract, so the release workflow knows the digest it
 * pins before image-ops pushes the artifact, and the push stores exactly
 * those bytes.
 *
 * `tools/deploy/kino-pin.json` is the Worker's `KINO_PINS_JSON`:
 * `{"<contract>":{"current":"sha256:<hex>","previous":"sha256:<hex>"|null}}`.
 *
 *   build --binary <kino> --version <X.Y.Z> --guest-contract <n> --out <dir>
 *   pin --file <kino-pin.json> --guest-contract <n> --digest <sha256:hex>
 *   check --file <kino-pin.json>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KINO_ARTIFACT_TYPE = "application/vnd.intar.kino.v1";
export const KINO_CONFIG_MEDIA_TYPE = "application/vnd.intar.kino.config.v1+json";
export const KINO_BINARY_MEDIA_TYPE = "application/octet-stream";
export const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
/** The largest Kino an agent puts on a run disk (MAX_KINO_BYTES in intar-agent). */
const MAX_BINARY_BYTES = 15 * 1024 * 1024;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}

export interface KinoArtifact {
  config: Uint8Array;
  manifest: Uint8Array;
  digest: string;
  descriptors: { config: Descriptor; binary: Descriptor };
}

export type KinoPins = Record<string, { current: string; previous: string | null }>;

function descriptor(mediaType: string, bytes: Uint8Array): Descriptor {
  return { mediaType, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.byteLength };
}

export function kinoArtifact(binary: Uint8Array, version: string, guestContract: number): KinoArtifact {
  if (!VERSION_RE.test(version)) throw new Error(`not a release version: ${version}`);
  if (!Number.isSafeInteger(guestContract) || guestContract < 1) throw new Error("the guest contract is a positive integer");
  if (binary.byteLength === 0 || binary.byteLength > MAX_BINARY_BYTES) throw new Error("the Kino binary is empty or over the run disk's limit");
  const config = new TextEncoder().encode(JSON.stringify({ guest_contract: guestContract, version }));
  const descriptors = {
    config: descriptor(KINO_CONFIG_MEDIA_TYPE, config),
    binary: descriptor(KINO_BINARY_MEDIA_TYPE, binary),
  };
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: KINO_ARTIFACT_TYPE,
    config: descriptors.config,
    layers: [descriptors.binary],
  }));
  return { config, manifest, digest: descriptor(OCI_MANIFEST_MEDIA_TYPE, manifest).digest, descriptors };
}

/** Reads a pin set by the rules the Worker reads `KINO_PINS_JSON` by. */
export function parseKinoPins(text: string): KinoPins {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the Kino pin is not an object");
  const pins: KinoPins = {};
  for (const [contract, entry] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(contract)) throw new Error(`not a guest contract: ${contract}`);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`pin ${contract} is not an object`);
    const { current, previous, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`pin ${contract} has unknown fields`);
    if (typeof current !== "string" || !DIGEST_RE.test(current)) throw new Error(`pin ${contract} has no current digest`);
    if (previous !== null && (typeof previous !== "string" || !DIGEST_RE.test(previous))) {
      throw new Error(`pin ${contract} has an invalid previous digest`);
    }
    pins[contract] = { current, previous };
  }
  return pins;
}

/** Pins `digest` for `guestContract`; the pin it replaces becomes `previous`. */
export function pinKino(pins: KinoPins, guestContract: number, digest: string): KinoPins {
  if (!DIGEST_RE.test(digest)) throw new Error(`not a digest: ${digest}`);
  const key = String(guestContract);
  const pinned = pins[key];
  if (pinned?.current === digest) return pins;
  return { ...pins, [key]: { current: digest, previous: pinned?.current ?? null } };
}

/** The pin file's text: one line, contracts in order. */
export function formatKinoPins(pins: KinoPins): string {
  const sorted = Object.fromEntries(Object.entries(pins).sort(([a], [b]) => Number(a) - Number(b)));
  return `${JSON.stringify(sorted)}\n`;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "build") {
    const artifact = kinoArtifact(
      readFileSync(argument("--binary")),
      argument("--version"),
      Number(argument("--guest-contract")),
    );
    const out = argument("--out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "config.json"), artifact.config);
    writeFileSync(join(out, "manifest.json"), artifact.manifest);
    console.log(JSON.stringify({ digest: artifact.digest, ...artifact.descriptors }));
  } else if (command === "pin") {
    const file = argument("--file");
    const pins = existsSync(file) ? parseKinoPins(readFileSync(file, "utf8")) : {};
    writeFileSync(file, formatKinoPins(pinKino(pins, Number(argument("--guest-contract")), argument("--digest"))));
  } else if (command === "check") {
    // The compact form is what the deploy writes into KINO_PINS_JSON.
    console.log(JSON.stringify(parseKinoPins(readFileSync(argument("--file"), "utf8"))));
  } else {
    console.error("usage: kino-artifact.ts build|pin|check ... (see the header)");
    process.exit(2);
  }
}
