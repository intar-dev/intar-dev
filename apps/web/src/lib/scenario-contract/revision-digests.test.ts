import { describe, expect, it } from "vitest";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
import type { ScenarioV1 } from "@/generated/contracts/source-bundle-v2";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import revisionFixture from "@/generated/fixtures/scenario/broken-nginx-revision.json";
import schema from "@/generated/schemas/scenario-revision-v1.schema.json";
import {
  behaviourDigest,
  restoreBasis,
  restoreDigest,
  REVISION_FIELDS_NOT_BEHAVIOUR,
  TASK_FIELDS_NOT_BEHAVIOUR,
} from "./revision-digests";

const doc = (): ScenarioRevisionV1 =>
  JSON.parse((revisionFixture as { revision: { json: string } }).revision.json) as ScenarioRevisionV1;
const scenario = (): ScenarioV1 =>
  structuredClone((bundleFixture as unknown as { scenarios: ScenarioV1[] }).scenarios[0]!);

describe("the behaviour digest", () => {
  it("decides for every field of the contract whether it is behaviour", () => {
    // A field added to the contract shows up here: it is behaviour until it
    // is put on the list on purpose.
    const fields = (properties: object) => Object.keys(properties).sort();
    expect(fields(schema.properties)).toEqual(
      [...REVISION_FIELDS_NOT_BEHAVIOUR, "machines", "tasks"].sort(),
    );
    expect(fields(schema.$defs.RevisionTaskV1.properties)).toEqual(
      [...TASK_FIELDS_NOT_BEHAVIOUR, "id", "machine", "needs", "optional", "ordinal"].sort(),
    );
    expect(fields(schema.$defs.RevisionMachineV1.properties)).toEqual([
      "build_key", "cluster_key", "cpu_millis", "disk_mib", "egress", "image_digest", "memory_mib", "name", "spec", "terminal",
      "verify_spec",
    ]);
  });

  it("is the same for other words and other for anything a run depends on", async () => {
    const base = await behaviourDigest(doc());
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    const changed = async (change: (revision: ScenarioRevisionV1) => void) => {
      const revision = doc();
      change(revision);
      return behaviourDigest(revision);
    };
    for (const words of [
      (r: ScenarioRevisionV1) => { r.title = "Another title"; },
      (r: ScenarioRevisionV1) => { r.briefing = "Other words"; },
      (r: ScenarioRevisionV1) => { r.solution = "Another way to say it"; },
      (r: ScenarioRevisionV1) => { r.summary = "x"; r.tags = ["y"]; r.minutes = 99; r.difficulty = "hard" as never; },
      (r: ScenarioRevisionV1) => { r.hints = [{ id: "h", body: "new" }]; },
      (r: ScenarioRevisionV1) => { r.play = !r.play; },
      (r: ScenarioRevisionV1) => { r.tasks[0]!.title = "Renamed"; r.tasks[0]!.body = "Retold"; r.tasks[0]!.hints = []; },
    ]) {
      expect(await changed(words)).toBe(base);
    }
    for (const behaviour of [
      (r: ScenarioRevisionV1) => { r.machines[0]!.spec = `sha256:${"1".repeat(64)}`; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.verify_spec = `sha256:${"2".repeat(64)}`; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.image_digest = `sha256:${"3".repeat(64)}`; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.build_key = `sha256:${"4".repeat(64)}`; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.memory_mib += 1; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.egress = !r.machines[0]!.egress; },
      (r: ScenarioRevisionV1) => { r.tasks[0]!.optional = !r.tasks[0]!.optional; },
      (r: ScenarioRevisionV1) => { r.tasks[0]!.needs = ["something"]; },
      (r: ScenarioRevisionV1) => { r.tasks.reverse(); },
      (r: ScenarioRevisionV1) => { r.tasks.pop(); },
    ]) {
      expect(await changed(behaviour)).not.toBe(base);
    }
  });
});

describe("the restore digest", () => {
  it("follows a machine's image, shape and spec without its tasks, and nothing else", async () => {
    const basis = await restoreBasis(scenario(), "intar/broken-nginx");
    const base = await restoreDigest(basis, doc());

    // A task's check, its solve script or the words change no snapshot start.
    const checks = scenario();
    checks.tasks[0]!.check = "true";
    checks.title = "Other";
    expect(await restoreBasis(checks, "intar/broken-nginx")).toBe(basis);
    const words = doc();
    words.briefing = "Other";
    words.machines[0]!.spec = `sha256:${"1".repeat(64)}`;
    words.machines[0]!.verify_spec = `sha256:${"2".repeat(64)}`;
    expect(await restoreDigest(basis, words)).toBe(base);

    // What the machine is when it comes up does.
    for (const change of [
      (s: ScenarioV1) => { s.machines[0]!.env = { ...s.machines[0]!.env, EXTRA: "1" }; },
      (s: ScenarioV1) => { s.machines[0]!.ready = [...s.machines[0]!.ready, { name: "more", script: "true" }] as never; },
      (s: ScenarioV1) => { s.machines[0]!.defer = [...s.machines[0]!.defer, "another.service"]; },
    ]) {
      const other = scenario();
      change(other);
      expect(await restoreBasis(other, "intar/broken-nginx")).not.toBe(basis);
    }
    for (const change of [
      (r: ScenarioRevisionV1) => { r.machines[0]!.image_digest = `sha256:${"3".repeat(64)}`; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.cpu_millis += 1; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.disk_mib += 1; },
      (r: ScenarioRevisionV1) => { r.machines[0]!.egress = !r.machines[0]!.egress; },
    ]) {
      const other = doc();
      change(other);
      expect(await restoreDigest(basis, other)).not.toBe(base);
    }
    expect(await restoreDigest(`sha256:${"9".repeat(64)}`, doc())).not.toBe(base);
  });
});
