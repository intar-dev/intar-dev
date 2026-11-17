// Ports of `ScenarioV1::machine_spec` and `ScenarioRevisionV1::new` from
// crates/intar-contracts/src/scenario.rs: what one machine's Kino runs, and
// the revision document the Worker stores, with the same canonical bytes.

import type { MachineSpecV1, SpecTaskV1 } from "@/generated/contracts/machine-spec-v1";
import type {
  RevisionMachineV1,
  ScenarioRevisionV1,
} from "@/generated/contracts/scenario-revision-v1";
import type { HintV1, ScenarioV1 } from "@/generated/contracts/source-bundle-v2";
import type { BuildKeys } from "./build-key";
import { canonicalJson, sha256Digest } from "./canonical-json";

export type SpecMode = "learn" | "verify";

/**
 * The spec of one machine, or null for an unknown machine. A learn spec
 * holds no solve script; a need on another machine is `<machine>/<task>`.
 */
export function machineSpec(
  scenario: ScenarioV1,
  scenarioId: string,
  machine: string,
  mode: SpecMode,
): MachineSpecV1 | null {
  const declared = scenario.machines.find((entry) => entry.name === machine);
  if (!declared) return null;
  const home = new Map(scenario.tasks.map((task) => [task.id, task.machine]));
  const tasks = scenario.tasks
    .filter((task) => task.machine === machine)
    .map((task): SpecTaskV1 => {
      const needs = task.needs.map((need) => {
        const other = home.get(need);
        return other !== undefined && other !== machine ? `${other}/${need}` : need;
      });
      const solve = mode === "verify" ? task.solve : null;
      return { id: task.id, check: task.check, needs, ...(solve == null ? {} : { solve }) };
    });
  return {
    scenario_id: scenarioId,
    machine,
    env: { ...declared.env },
    defer: [...declared.defer],
    ready: [...declared.ready],
    tasks,
  };
}

/** The spec blob, canonical JSON, and its digest. */
export async function specBlob(spec: MachineSpecV1): Promise<{ json: string; digest: string }> {
  const json = canonicalJson(spec);
  return { json, digest: await sha256Digest(json) };
}

// `null` is how JSON spells an absent optional field; the stored document
// omits it, as serde does.
const hints = (list: HintV1[]) =>
  list.map(({ id, title, body }) => ({ id, ...(title == null ? {} : { title }), body }));

/**
 * The revision of a valid scenario, stored under `scenarioId`, with the
 * machine keys of `buildKeys` and no image digests yet.
 */
export async function scenarioRevision(
  scenario: ScenarioV1,
  scenarioId: string,
  keys: BuildKeys,
): Promise<ScenarioRevisionV1> {
  const machines: RevisionMachineV1[] = [];
  for (const machine of scenario.machines) {
    const { name } = machine;
    const digest = async (mode: SpecMode) => {
      const spec = machineSpec(scenario, scenarioId, name, mode);
      if (!spec) throw new Error(`machine \`${name}\`: no spec`);
      return (await specBlob(spec)).digest;
    };
    const buildKey = keys.machines[name];
    if (buildKey === undefined) throw new Error(`machine \`${name}\`: no build key`);
    machines.push({
      name,
      cpu_millis: machine.cpu_millis,
      memory_mib: machine.memory_mib,
      disk_mib: machine.disk_mib,
      terminal: machine.terminal,
      egress: machine.egress,
      build_key: buildKey,
      spec: await digest("learn"),
      verify_spec: await digest("verify"),
    });
  }
  return {
    title: scenario.title,
    summary: scenario.summary,
    difficulty: scenario.difficulty,
    minutes: scenario.minutes,
    tags: [...scenario.tags],
    ...(scenario.credit == null ? {} : { credit: scenario.credit }),
    play: scenario.play,
    briefing: scenario.briefing,
    solution: scenario.solution,
    hints: hints(scenario.hints),
    tasks: scenario.tasks.map((task, ordinal) => ({
      id: task.id,
      title: task.title,
      ...(task.body == null ? {} : { body: task.body }),
      machine: task.machine,
      needs: [...task.needs],
      optional: task.optional,
      ordinal,
      hints: hints(task.hints),
    })),
    machines,
  };
}
