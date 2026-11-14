import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import compileDigest from "@/generated/fixtures/source/compile-digest-v2.json";
import { MAX_SOURCE_BUNDLE_JSON_BYTES, readSourceBundle, sourceCompileDigest } from "./source-bundle";

const fixture = (name: string) =>
  readFileSync(new URL(`../../generated/fixtures/scenario/${name}`, import.meta.url), "utf8");
const gz = (value: unknown) =>
  new Uint8Array(gzipSync(typeof value === "string" ? value : JSON.stringify(value)));
const bundle = () => JSON.parse(fixture("broken-nginx-bundle.json")) as Record<string, unknown>;

describe("readSourceBundle", () => {
  it("reads the Rust-compiled bundle", async () => {
    const read = await readSourceBundle(gz(fixture("broken-nginx-bundle.json")));
    expect(read.scenarios.map((scenario) => scenario.slug)).toEqual(["broken-nginx"]);
  });

  it("derives the compile digest Rust derives", async () => {
    expect(await sourceCompileDigest()).toBe(compileDigest.digest);
  });

  it.each([
    ["an older compiler", { compiler: "intar-source-compiler-v1" }],
    ["another image format", { image_format: "intar-image-2" }],
  ])("refuses %s as compiler_outdated", async (_name, change) => {
    await expect(readSourceBundle(gz({ ...bundle(), ...change }))).rejects.toMatchObject({
      status: 409,
      code: "compiler_outdated",
    });
  });

  it("refuses an oversized gzip and a gzip bomb", async () => {
    await expect(readSourceBundle(new Uint8Array(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
    // 33 MiB of spaces gzips to a few dozen KiB.
    const bomb = gz(`${" ".repeat(33 * 1024 * 1024)}{}`);
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(readSourceBundle(bomb)).rejects.toMatchObject({ status: 413 });
  });

  it("caps the inflated size at 16 MiB", async () => {
    expect(MAX_SOURCE_BUNDLE_JSON_BYTES).toBe(16 * 1024 * 1024);
    const padded = (spaces: number) => gz(`${" ".repeat(spaces)}${fixture("broken-nginx-bundle.json")}`);
    const size = new TextEncoder().encode(fixture("broken-nginx-bundle.json")).byteLength;
    await expect(readSourceBundle(padded(MAX_SOURCE_BUNDLE_JSON_BYTES - size))).resolves.toBeTruthy();
    await expect(readSourceBundle(padded(MAX_SOURCE_BUNDLE_JSON_BYTES - size + 1))).rejects.toMatchObject({
      status: 413,
    });
  });

  it("refuses a scenario whose stored document would be over D1's value limit", async () => {
    const value = bundle() as { scenarios: { slug: string; tasks: Record<string, unknown>[] }[] };
    const [task] = value.scenarios[0]!.tasks;
    value.scenarios[0]!.tasks = Array.from({ length: 32 }, (_, n) => ({
      ...task,
      id: `task-${String(n).padStart(2, "0")}`,
      needs: [],
      body: "x".repeat(63_000),
    }));
    await expect(readSourceBundle(gz(value))).rejects.toMatchObject({
      status: 400,
      code: "bundle_invalid",
      message: "scenario `broken-nginx`: its stored document is over 2000000 bytes",
    });
  });

  it.each([
    ["not gzip", new TextEncoder().encode("plain")],
    ["not JSON", gz("{")],
    ["an unknown field", gz({ ...bundle(), extra: 1 })],
  ])("refuses %s with 400", async (_name, bytes) => {
    await expect(readSourceBundle(bytes)).rejects.toMatchObject({ status: 400, code: "bundle_invalid" });
  });

  const refusals = JSON.parse(fixture("bundle-refusals.json")) as { name: string; bundle: unknown; problems: string[] }[];
  it.each(refusals.map((entry) => [entry.name, entry] as const))("refuses %s with Rust's problems", async (_name, entry) => {
    const error = await readSourceBundle(gz(entry.bundle)).catch((caught: unknown) => caught);
    // A refusal that is only a compiler or format change answers outdated.
    if ((error as { code?: string }).code === "compiler_outdated") return;
    expect(error).toMatchObject({ status: 400, code: "bundle_invalid", message: entry.problems.join("\n") });
  });
});
