import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { kinoArtifact } from "./kino-artifact.ts";
import { type Io, resolvePins } from "./release-pins.ts";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true });
});

interface Release {
  files: Record<string, string>;
  draft?: boolean;
  prerelease?: boolean;
  offMain?: boolean;
  unattested?: string[];
  source?: Record<string, string>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const compiler = (version: string) => ({ "crates/intar-contracts/src/source.rs": `pub const SOURCE_COMPILER_VERSION_V2: &str = "${version}";\n` });
const contract = (n: number) => ({ "crates/intar-contracts/src/guest.rs": `pub const GUEST_CONTRACT: u32 = ${n};\n` });

function withSums(prefix: string, version: string, names: string[]): Record<string, string> {
  const files = Object.fromEntries(names.map((name) => [name, `${name} bytes`]));
  files[`${prefix}_${version}_checksums.txt`] = names.map((name) => `${sha(files[name]!)}  ${name}`).join("\n");
  return files;
}
const imageCli = (version: string, extra: Partial<Release> = {}): [string, Release] => [`image-cli/v${version}`, {
  files: withSums("intar-image-cli", version, ["linux_amd64", "linux_arm64"].map((t) => `intar-image-cli_${version}_${t}.tar.gz`)),
  source: compiler("2"),
  ...extra,
}];
const desktop = (version: string, extra: Partial<Release> = {}): [string, Release] => [`desktop/v${version}`, {
  files: withSums("intar-desktop", version, [`intar-desktop_${version}_macos_arm64.zip`]),
  ...extra,
}];
const kino = (version: string, guestContract: number, extra: Partial<Release> = {}): [string, Release] => [`kino/v${version}`, {
  files: withSums("kino", version, ["amd64", "arm64"].map((a) => `kino_${version}_linux_${a}.tar.gz`)),
  source: contract(guestContract),
  ...extra,
}];
// The artifact digest the resolver computes for a fixture archive: its
// "binary" is the archive's own text.
const digestOf = (version: string, guestContract: number, architecture: "amd64" | "arm64") =>
  kinoArtifact(new TextEncoder().encode(`kino_${version}_linux_${architecture}.tar.gz bytes`), version, guestContract, architecture).digest;

function resolve(entries: [string, Release][], options: { unstored?: string[]; compiler?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-pins-"));
  roots.push(dir);
  const releases = new Map(entries);
  const warnings: string[] = [];
  const io: Io = {
    releases: () => [...releases].map(([tag, release]) => ({ tag, draft: release.draft ?? false, prerelease: release.prerelease ?? false })),
    onMain: (tag) => !releases.get(tag)!.offMain,
    file: (tag, path) => releases.get(tag)!.source?.[path] ?? null,
    download(tag, names) {
      const out: Record<string, string> = {};
      for (const name of names) {
        const text = releases.get(tag)!.files[name];
        if (text === undefined) continue;
        out[name] = join(dir, name);
        writeFileSync(out[name], text);
      }
      return out;
    },
    attested: (path) => !entries.some(([, release]) => release.unattested?.some((name) => path.endsWith(name))),
    kinoBinary: (archive) => new TextEncoder().encode(`${archive.split("/").pop()} bytes`),
    stored: (digests) => new Set(digests.filter((digest) => !options.unstored?.includes(digest))),
    warn: (message) => warnings.push(message),
  };
  return { pins: resolvePins(io, { compiler: options.compiler ?? "2" }), warnings };
}

test("pins the newest published release by version, never a draft or a prerelease", () => {
  const { pins } = resolve([
    desktop("0.9.0"), desktop("0.10.0"), desktop("0.11.0", { prerelease: true }), desktop("0.12.0", { draft: true }),
  ]);
  expect(JSON.parse(pins.JUMPER_RELEASE_JSON!).macos_arm64.version).toBe("0.10.0");
});

test("a release off main or without the release workflow's attestation is not pinned", () => {
  const { pins, warnings } = resolve([
    desktop("0.1.0"),
    desktop("0.2.0", { unattested: ["intar-desktop_0.2.0_macos_arm64.zip"] }),
    desktop("0.3.0", { offMain: true }),
  ]);
  expect(JSON.parse(pins.JUMPER_RELEASE_JSON!)).toEqual({
    macos_arm64: { sha256: sha("intar-desktop_0.1.0_macos_arm64.zip bytes"), version: "0.1.0" },
  });
  expect(warnings.join("\n")).toContain("desktop/v0.3.0 is not on main");
  expect(warnings.join("\n")).toContain("desktop/v0.2.0's intar-desktop_0.2.0_macos_arm64.zip has no attestation");
});

test("a file that does not match its checksums is not pinned", () => {
  const [tag, release] = desktop("0.2.0");
  release.files["intar-desktop_0.2.0_macos_arm64.zip"] = "replaced";
  expect(JSON.parse(resolve([desktop("0.1.0"), [tag, release]]).pins.JUMPER_RELEASE_JSON!).macos_arm64.version).toBe("0.1.0");
});

test("the compiler is the newest image CLI that compiles HEAD's source format", () => {
  const { pins } = resolve([imageCli("0.20.0"), imageCli("0.21.0", { source: compiler("1") })]);
  expect(pins.SCENARIO_COMPILER_CLI_VERSION).toBe("0.20.0");
  expect(JSON.parse(pins.SCENARIO_COMPILER_CLI_SHA256!)).toEqual({
    linux_amd64: sha("intar-image-cli_0.20.0_linux_amd64.tar.gz bytes"),
    linux_arm64: sha("intar-image-cli_0.20.0_linux_arm64.tar.gz bytes"),
  });
});

test("until an image CLI compiles HEAD's new source format, the newest one stays pinned", () => {
  const { pins, warnings } = resolve([imageCli("0.20.0"), imageCli("0.21.0")], { compiler: "3" });
  expect(pins.SCENARIO_COMPILER_CLI_VERSION).toBe("0.21.0");
  expect(warnings.join("\n")).toContain("compiles source format 3");
});

test("each guest contract keeps its Kino pin, current and previous per architecture", () => {
  const { pins } = resolve([kino("0.5.0", 3), kino("0.6.0", 3), kino("0.7.0", 3), kino("0.8.0", 4)]);
  expect(JSON.parse(pins.KINO_PINS_JSON!)).toEqual({
    "3": {
      current: digestOf("0.7.0", 3, "amd64"), previous: digestOf("0.6.0", 3, "amd64"),
      arm64: { current: digestOf("0.7.0", 3, "arm64"), previous: digestOf("0.6.0", 3, "arm64") },
    },
    "4": {
      current: digestOf("0.8.0", 4, "amd64"), previous: null,
      arm64: { current: digestOf("0.8.0", 4, "arm64"), previous: null },
    },
  });
  expect(JSON.parse(pins.KINO_RELEASES_JSON!)["4"].amd64).toEqual({
    version: "0.8.0", sha256: sha("kino_0.8.0_linux_amd64.tar.gz bytes"),
  });
});

test("a Kino release the registry does not store yet is skipped, not fatal", () => {
  const { pins, warnings } = resolve(
    [kino("0.6.0", 3), kino("0.7.0", 3), kino("0.8.0", 3)],
    { unstored: [digestOf("0.8.0", 3, "amd64"), digestOf("0.8.0", 3, "arm64")] },
  );
  const pin = JSON.parse(pins.KINO_PINS_JSON!)["3"];
  expect(pin.current).toBe(digestOf("0.7.0", 3, "amd64"));
  expect(pin.previous).toBe(digestOf("0.6.0", 3, "amd64"));
  expect(warnings.join("\n")).toContain("no amd64 artifact of kino 0.8.0");
});

test("no release at all pins nothing, and a Kino tag from before guest contracts is no release", () => {
  const { pins, warnings } = resolve([kino("0.1.0", 3, { source: {} })]);
  expect(pins).toEqual({});
  expect(warnings.join("\n")).toContain("No Kino release yet");
});

test("releases that exist but none qualifies stop the deploy instead of dropping the pin", () => {
  expect(() => resolve([desktop("0.1.0", { offMain: true })])).toThrow("intar-desktop");
  expect(() => resolve([imageCli("0.1.0", { unattested: ["intar-image-cli_0.1.0_linux_amd64.tar.gz"] })])).toThrow("intar-image-cli");
  const unstored = [digestOf("0.1.0", 3, "amd64"), digestOf("0.1.0", 3, "arm64")];
  expect(() => resolve([kino("0.1.0", 3)], { unstored })).toThrow("Kino");
});
