// Client-side loader for the Rust scenario validator (intar-image-scenario
// compiled to wasm). Validation runs entirely in the browser with the exact
// same code the build pipeline uses — no backend round-trip, no drift.

import init, {
  content_hash,
  validate,
} from "@/generated/scenario-wasm/intar_image_scenario_wasm";
import wasmUrl from "@/generated/scenario-wasm/intar_image_scenario_wasm_bg.wasm?url";

export interface ScenarioValidationResult {
  ok: boolean;
  errors: string[];
  /** serde-serialized Scenario when the HCL parsed (even if invalid). */
  preview: ScenarioPreview | null;
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
    hostname?: string | null;
    image: string;
    resources?: {
      cpu?: number;
      memory_mib?: number;
      disk_mib?: number;
    } | null;
  }>;
  kino: {
    probes?: Array<{
      name: string;
      phase?: string | null;
      description?: string | null;
    }>;
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
