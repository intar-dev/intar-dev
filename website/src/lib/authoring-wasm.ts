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

// Mirrors the serde serialization of `intar_image_scenario::Scenario` —
// notably `kino.probes` is a map keyed by probe name, and VM resources are
// flat cpu/memory/disk fields.
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
    cpu: number;
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
