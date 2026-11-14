import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatKinoPins, kinoArtifact, parseKinoPins, pinKino } from "./kino-artifact";

const sha = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const binary = new TextEncoder().encode("\x7fELF a static kino");

describe("Kino artifact", () => {
  test("is the manifest the registry stores for a Kino push, and the same bytes every time", () => {
    const artifact = kinoArtifact(binary, "0.6.0", 3);
    const manifest = JSON.parse(new TextDecoder().decode(artifact.manifest));
    // What handleManifestPut accepts from the publish token for a Kino artifact.
    expect(manifest).toEqual({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.intar.kino.v1",
      config: { mediaType: "application/vnd.intar.kino.config.v1+json", digest: sha(artifact.config), size: artifact.config.byteLength },
      layers: [{ mediaType: "application/octet-stream", digest: sha(binary), size: binary.byteLength }],
    });
    expect(JSON.parse(new TextDecoder().decode(artifact.config))).toEqual({ guest_contract: 3, version: "0.6.0" });
    expect(artifact.digest).toBe(sha(artifact.manifest));
    expect(kinoArtifact(binary, "0.6.0", 3).digest).toBe(artifact.digest);
    expect(kinoArtifact(binary, "0.6.1", 3).digest).not.toBe(artifact.digest);
  });

  test("refuses what no agent would run", () => {
    expect(() => kinoArtifact(binary, "v0.6.0", 3)).toThrow();
    expect(() => kinoArtifact(binary, "0.6.0", 0)).toThrow();
    expect(() => kinoArtifact(new Uint8Array(), "0.6.0", 3)).toThrow();
    expect(() => kinoArtifact(new Uint8Array(15 * 1024 * 1024 + 1), "0.6.0", 3)).toThrow();
  });
});

describe("Kino pin", () => {
  const a = `sha256:${"a".repeat(64)}`;
  const b = `sha256:${"b".repeat(64)}`;
  const c = `sha256:${"c".repeat(64)}`;

  test("moves the replaced pin to previous and leaves other contracts alone", () => {
    const first = pinKino({}, 3, a);
    expect(first).toEqual({ "3": { current: a, previous: null } });
    expect(pinKino(first, 3, a)).toBe(first);
    const second = pinKino({ ...first, "2": { current: c, previous: null } }, 3, b);
    expect(second).toEqual({ "2": { current: c, previous: null }, "3": { current: b, previous: a } });
    expect(formatKinoPins(second)).toBe(`{"2":{"current":"${c}","previous":null},"3":{"current":"${b}","previous":"${a}"}}\n`);
  });

  test("reads only the shape the Worker reads", () => {
    expect(parseKinoPins(`{"3":{"current":"${a}","previous":null}}`)).toEqual({ "3": { current: a, previous: null } });
    for (const text of ["[]", `{"x":{"current":"${a}","previous":null}}`, `{"3":{"current":"sha256:A","previous":null}}`,
      `{"3":{"current":"${a}","previous":"b"}}`, `{"3":{"current":"${a}","previous":null,"extra":1}}`, "{"]) {
      expect(() => parseKinoPins(text), text).toThrow();
    }
  });

  test("the CLI builds the artifact files and writes and checks the pin file", () => {
    const root = mkdtempSync(join(tmpdir(), "intar-kino-artifact-"));
    try {
      writeFileSync(join(root, "kino"), binary);
      const run = (...args: string[]) => spawnSync("bun", ["tools/deploy/kino-artifact.ts", ...args], { encoding: "utf8" });
      const built = run("build", "--binary", join(root, "kino"), "--version", "0.6.0", "--guest-contract", "3", "--out", join(root, "out"));
      expect(built.status, built.stderr).toBe(0);
      const { digest } = JSON.parse(built.stdout) as { digest: string };
      expect(sha(readFileSync(join(root, "out/manifest.json")))).toBe(digest);
      const file = join(root, "kino-pin.json");
      expect(run("pin", "--file", file, "--guest-contract", "3", "--digest", digest).status).toBe(0);
      const checked = run("check", "--file", file);
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toBe(`{"3":{"current":"${digest}","previous":null}}\n`);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("image-ops kino-promote", () => {
  // gh, git and curl are stand-ins; tar, sha256sum and the artifact builder are real.
  function promote(pin: string | null, failManifest = false) {
    const root = mkdtempSync(join(tmpdir(), "intar-kino-promote-"));
    const bin = join(root, "bin");
    const release = join(root, "release");
    spawnSync("mkdir", ["-p", bin, release, join(root, "repo/tools/deploy")]);
    writeFileSync(join(release, "kino"), binary);
    spawnSync("tar", ["-czf", join(release, "kino_0.6.0_linux_amd64.tar.gz"), "-C", release, "./kino"]);
    const archive = readFileSync(join(release, "kino_0.6.0_linux_amd64.tar.gz"));
    writeFileSync(join(release, "kino_0.6.0_checksums.txt"),
      `${createHash("sha256").update(archive).digest("hex")}  kino_0.6.0_linux_amd64.tar.gz\n${"0".repeat(64)}  kino_0.6.0_linux_arm64.tar.gz\n`);
    writeFileSync(join(root, "repo/tools/deploy/kino-artifact.ts"), readFileSync("tools/deploy/kino-artifact.ts"));
    if (pin !== null) writeFileSync(join(root, "repo/tools/deploy/kino-pin.json"), pin);
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      spawnSync("chmod", ["+x", join(bin, name)]);
    };
    script("gh", `case "$1 $2" in
  "release download") dir=""; while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    cp "${release}"/kino_0.6.0_linux_amd64.tar.gz "${release}"/kino_0.6.0_checksums.txt "$dir" ;;
  "attestation verify") echo "$@" >> "${root}/gh.log" ;;
  *) exit 1 ;;
esac`);
    script("git", `case "$1" in
  fetch) ;;
  show) [ "$2" = "kino/v0.6.0:crates/intar-contracts/src/guest.rs" ] && printf 'pub const GUEST_CONTRACT: u32 = 3;\\n' ;;
  *) exit 1 ;;
esac`);
    script("curl", `method=GET; url=""; file=""; session=""
while [ $# -gt 0 ]; do case "$1" in
  --request) method="$2"; shift 2 ;;
  --header) case "$2" in X-Intar-Registry-Session:*) session="\${2#*: }" ;; esac; shift 2 ;;
  --data-binary) file="\${2#@}"; shift 2 ;;
  --data) file="inline:$2"; shift 2 ;;
  --retry) shift 2 ;;
  -*) shift ;;
  *) url="$1"; shift ;;
esac; done
sum=""; body=""
case "$file" in inline:*) body="\${file#inline:}" ;; ?*) sum="$(shasum -a 256 "$file" | cut -d' ' -f1)" ;; esac
echo "$method \${url#https://registry.test} session=$session sum=$sum $body" >> "${root}/curl.log"
case "$url" in
  */upload-sessions) echo '{"session_id":"s-1"}' ;;
  */manifests/*) [ "${failManifest}" = true ] && exit 22 ;;
esac
exit 0`);
    try {
      const run = spawnSync("bash", [resolve("tools/workflows/image-ops/kino-promote.sh")], {
        cwd: join(root, "repo"),
        encoding: "utf8",
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, KINO_VERSION: "0.6.0", INTAR_IMAGE_PUBLISH_TOKEN: "t",
          GITHUB_REPOSITORY: "owner/repo", RUNNER_TEMP: root, REGISTRY_URL: "https://registry.test",
          GITHUB_STEP_SUMMARY: join(root, "summary.md"),
        },
      });
      const read = (name: string) => { try { return readFileSync(join(root, name), "utf8"); } catch { return ""; } };
      return { status: run.status, stderr: run.stderr, curl: read("curl.log").trim().split("\n"), gh: read("gh.log"), summary: read("summary.md") };
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }

  test("pushes the blobs and then the manifest in one session, and says whether main pins it", () => {
    const artifact = kinoArtifact(binary, "0.6.0", 3);
    const hex = (digest: string) => digest.slice("sha256:".length);
    const ran = promote(`{"3":{"current":"${artifact.digest}","previous":null}}`);
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.gh).toContain("kino_0.6.0_linux_amd64.tar.gz");
    expect(ran.curl).toEqual([
      `POST /upload-sessions session= sum= {"intent":"kino-promote"}`,
      `PUT /blobs/${artifact.descriptors.config.digest} session=s-1 sum=${hex(artifact.descriptors.config.digest)} `,
      `PUT /blobs/${artifact.descriptors.binary.digest} session=s-1 sum=${hex(artifact.descriptors.binary.digest)} `,
      `PUT /manifests/${artifact.digest} session=s-1 sum=${hex(artifact.digest)} `,
      `POST /upload-sessions/complete session=s-1 sum= {"outcome":"published"}`,
    ]);
    expect(ran.summary).toContain("main already pins it");
    expect(promote(null).summary).toContain("main pins nothing");
  });

  test("abandons the session when a push fails", () => {
    const ran = promote(null, true);
    expect(ran.status).not.toBe(0);
    expect(ran.curl.at(-1)).toBe(`POST /upload-sessions/complete session=s-1 sum= {"outcome":"abandoned"}`);
  });
});
