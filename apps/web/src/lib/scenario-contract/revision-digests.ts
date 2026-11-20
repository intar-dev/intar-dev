// The two digests a revision is compared by when a new one of its scenario
// arrives (#454). Both are defined by what they leave out, so a field added
// to the document later counts until someone decides it does not.

import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
import type { ScenarioV1 } from "@/generated/contracts/source-bundle-v2";
import { canonicalJson, sha256Digest } from "./canonical-json";
import { machineSpec } from "./machine-spec";

/**
 * What of a revision only people read: a lab runs and is checked the same
 * with other words here. `play` is left out too: who may play a lab is an
 * administrator's setting, not a commit's.
 */
export const REVISION_FIELDS_NOT_BEHAVIOUR = [
  "briefing",
  "credit",
  "difficulty",
  "hints",
  "minutes",
  "play",
  "solution",
  "summary",
  "tags",
  "title",
] as const;
/** The same of one task. Its id, machine, needs, optional and ordinal are behaviour. */
export const TASK_FIELDS_NOT_BEHAVIOUR = ["body", "hints", "title"] as const;

function without<T extends object>(value: T, fields: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => !fields.includes(name))) as Partial<T>;
}

/**
 * The digest of how a revision behaves: its machines with their images,
 * shapes and specs, and its tasks' order and dependencies. Two revisions of
 * a scenario with the same one pass or fail a verify run alike.
 */
export function behaviourDigest(doc: ScenarioRevisionV1): Promise<string> {
  return sha256Digest(
    canonicalJson({
      ...without(doc, REVISION_FIELDS_NOT_BEHAVIOUR),
      // A stored document is read as it is: one without tasks has none.
      tasks: (doc.tasks ?? []).map((task) => without(task, TASK_FIELDS_NOT_BEHAVIOUR)),
    }),
  );
}

/**
 * The part of a scenario's machines a snapshot start depends on that the
 * revision document does not hold by itself: each machine's spec without
 * its tasks. The document has only the digest of the whole spec, so this is
 * taken at ingest, where the specs are built.
 */
export function restoreBasis(scenario: ScenarioV1, scenarioId: string): Promise<string> {
  return sha256Digest(
    canonicalJson(
      scenario.machines.map(({ name }) => {
        const spec = machineSpec(scenario, scenarioId, name, "learn");
        return { machine: name, env: spec?.env ?? {}, defer: spec?.defer ?? [], ready: spec?.ready ?? [] };
      }),
    ),
  );
}

/**
 * The digest of what a snapshot start of a revision depends on: the basis,
 * and each machine's image and shape. Two revisions of a scenario with the
 * same one start from a snapshot alike; their tasks may differ.
 */
export function restoreDigest(basis: string, doc: ScenarioRevisionV1): Promise<string> {
  return sha256Digest(
    canonicalJson({
      basis,
      machines: doc.machines.map((machine) => ({
        name: machine.name,
        image_digest: machine.image_digest ?? null,
        cpu_millis: machine.cpu_millis,
        memory_mib: machine.memory_mib,
        disk_mib: machine.disk_mib,
        egress: machine.egress,
      })),
    }),
  );
}
