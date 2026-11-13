import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_MACHINE_SPEC_BYTES } from "@/generated/constants";
import type { ImageV1, MachineV1, SourceBundleV2 } from "@/generated/contracts/source-bundle-v2";
import validateRevision from "@/generated/contracts/scenario-revision-v1.validate";
import validateSourceBundle from "@/generated/contracts/source-bundle-v2.validate";
import vectors from "@/generated/fixtures/scenario/build-keys.json";
import stored from "@/generated/fixtures/scenario/broken-nginx-revision.json";
import { baseKey, buildKeys } from "./build-key";
import { byteOrder, canonicalJson, sha256Digest } from "./canonical-json";
import { machineSpec, scenarioRevision, specBlob } from "./machine-spec";
import { validateBundle } from "./validate";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../generated/fixtures/scenario/${name}`, import.meta.url), "utf8"),
  ) as unknown;

function bundle(): SourceBundleV2 {
  const value = fixture("broken-nginx-bundle.json");
  if (!validateSourceBundle(value)) throw new Error("the bundle fixture is not a bundle");
  return value;
}

describe("build keys", () => {
  it("hold every golden vector", async () => {
    expect(vectors.image_format).toBe("intar-image-3");
    expect(await baseKey()).toBe(vectors.base_key);
    const found = new Map<string, string>();
    for (const testCase of vectors.cases) {
      const keys = await buildKeys(
        { machines: testCase.machines as MachineV1[] },
        testCase.images as ImageV1[],
      );
      expect(keys, testCase.name).toEqual(testCase.keys);
      for (const [machine, key] of Object.entries(keys.machines)) {
        found.set(`${testCase.name}/${machine}`, key);
      }
    }
    const key = (name: string) => {
      expect(found.has(name), name).toBe(true);
      return found.get(name);
    };
    for (const [one, other] of vectors.equal) expect(key(one!), `${one} = ${other}`).toBe(key(other!));
    for (const [one, other] of vectors.differ) expect(key(one!), `${one} != ${other}`).not.toBe(key(other!));
  });

  it("refuse unknown parents and cycles", async () => {
    const image = (name: string, from: string): ImageV1 => ({ name, from, defer: [], setup: [] });
    await expect(buildKeys({ machines: [] }, [image("a-img", "b-img"), image("b-img", "a-img")])).rejects.toThrow("cycle");
    await expect(buildKeys({ machines: [] }, [image("a-img", "nope")])).rejects.toThrow("names no image");
  });
});

describe("broken-nginx", () => {
  const scenario = () => bundle().scenarios.find((entry) => entry.slug === "broken-nginx")!;

  it("validates", () => {
    expect(validateBundle(bundle())).toEqual([]);
  });

  it("stores the same revision and spec bytes as Rust", async () => {
    const value = bundle();
    const keys = await buildKeys(scenario(), value.images);
    const revision = await scenarioRevision(scenario(), stored.scenario_id, keys);
    expect(validateRevision(revision)).toBe(true);
    const json = canonicalJson(revision);
    expect(json).toBe(stored.revision.json);
    expect(await sha256Digest(json)).toBe(stored.revision.digest);
    for (const [machine, modes] of Object.entries(stored.specs)) {
      for (const [mode, blob] of Object.entries(modes)) {
        const spec = machineSpec(scenario(), stored.scenario_id, machine, mode as "learn" | "verify");
        expect(await specBlob(spec!)).toEqual(blob);
      }
    }
  });

  it("refuses a spec over the limit", () => {
    const value = bundle();
    const [first] = value.scenarios[0]!.tasks;
    value.scenarios[0]!.tasks = [0, 1, 2, 3, 4].map((n) => ({
      ...first!,
      id: `task-${n}`,
      check: "x".repeat(MAX_MACHINE_SPEC_BYTES / 5),
    }));
    expect(validateBundle(value)).toContain(
      `scenario \`broken-nginx\`: machine \`webserver\`: its spec is over ${MAX_MACHINE_SPEC_BYTES} bytes`,
    );
  });
});

describe("bundle refusals", () => {
  const cases = fixture("bundle-refusals.json") as {
    name: string;
    bundle: unknown;
    problems: string[];
  }[];

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s is refused as in Rust", (_, entry) => {
    // Only the rules refuse it: it is a well-formed bundle.
    expect(validateSourceBundle(entry.bundle)).toBe(true);
    expect(validateBundle(entry.bundle as SourceBundleV2)).toEqual(entry.problems);
  });
});

describe("canonical JSON", () => {
  it("sorts keys by UTF-8 bytes and drops undefined members", () => {
    expect(byteOrder("\u{ff61}", "\u{10000}")).toBeLessThan(0);
    expect(canonicalJson({ b: [1, { d: null, c: "é" }], a: undefined, "\u{10000}": 1, "\u{ff61}": 2 })).toBe(
      '{"b":[1,{"c":"é","d":null}],"\u{ff61}":2,"\u{10000}":1}',
    );
  });
});
