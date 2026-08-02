// Client-side loader for the Rust scenario validator (intar-image-scenario
// compiled to wasm). Validation runs entirely in the browser with the exact
// same code the build pipeline uses — no backend round-trip, no drift.

import init, {
  content_hash,
  prepare_build,
  validate,
} from "@/generated/scenario-wasm/intar_image_scenario_wasm";
import wasmUrl from "@/generated/scenario-wasm/intar_image_scenario_wasm_bg.wasm?url";

export interface ScenarioValidationResult {
  ok: boolean;
  errors: string[];
  /** serde-serialized Scenario when the HCL parsed (even if invalid). */
  preview: ScenarioPreview | null;
}

// Mirrors the serde serialization of `intar_image_scenario::Scenario` —
// notably `kino.probes` is a map keyed by probe name, and VM resources are
// flat cpu_millis/vcpu_count/memory/disk fields.
export interface ScenarioPreviewProbe {
  name: string;
  description?: string | null;
  title?: string | null;
  phase?: string | null;
  config?: unknown;
}

export interface ScenarioPreview {
  name: string;
  title: string;
  category: string;
  tags: string[];
  difficulty: "easy" | "medium" | "hard" | null;
  estimated_minutes: number | null;
  description: string;
  briefing: string;
  hints: Array<{ id: string; title?: string | null }>;
  vms: Array<{
    name: string;
    cpu_millis: number;
    vcpu_count: number;
    memory: number;
    disk: number;
    image: string;
    probes: string[];
  }>;
  kino: {
    probes?: Record<string, ScenarioPreviewProbe> | null;
  };
}

let initialized: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  initialized ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  await initialized;
}

export async function validateScenarioHcl(
  scenarioHcl: string,
): Promise<ScenarioValidationResult> {
  await ensureLoaded();
  return JSON.parse(validate(scenarioHcl)) as ScenarioValidationResult;
}

export interface PreparedBuild {
  ok: boolean;
  errors: string[];
  scenario_id?: string;
  content_hash?: string;
  kino_version?: string;
  target_arch: string;
  image_arch: string;
}

// Validate + compute the source-bundle inputs (content hash, kino version,
// arch) for the in-app build trigger. Runs the exact build-pipeline Rust.
export async function prepareScenarioBuild(
  scenarioHcl: string,
): Promise<PreparedBuild> {
  await ensureLoaded();
  return JSON.parse(prepare_build(scenarioHcl)) as PreparedBuild;
}

export async function computeScenarioContentHash(params: {
  scenarioId: string;
  baseDefinition: string;
  kinoVersion: string;
  targetArch?: string;
  entries: Array<{ path: string; content: string }>;
}): Promise<string> {
  await ensureLoaded();
  return content_hash(
    JSON.stringify({
      scenario_id: params.scenarioId,
      base_definition: params.baseDefinition,
      kino_version: params.kinoVersion,
      target_arch: params.targetArch,
      entries: params.entries,
    }),
  );
}
