import type {
  ScenarioDetailRecord,
  ScenarioListRecord,
} from "@/lib/scenarios";
import type { AdminScenarioSummary } from "@/components/app/admin/hosts/types";

export function serializeAdminScenarioSummary(
  scenario: ScenarioListRecord,
): AdminScenarioSummary {
  return {
    scenarioId: scenario.scenarioId,
    title: scenario.title,
    category: scenario.category,
    description: scenario.description,
    difficulty: scenario.difficulty,
    estimatedMinutes: scenario.estimatedMinutes,
    tags: scenario.tags,
    scenarioHintCount: scenario.hints.length,
    probeCount: scenario.probeCount,
    vmCount: scenario.vmCount,
    enabled: scenario.enabled,
    enabledAt: scenario.enabledAt,
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
  };
}

export function serializeAdminScenarioDetail(scenario: ScenarioDetailRecord) {
  return {
    ...serializeAdminScenarioSummary(scenario),
    briefingMarkdown: scenario.briefingMarkdown,
    solutionMarkdown: scenario.solutionMarkdown,
    hints: scenario.hints,
    probes: scenario.probes,
    vms: scenario.vms,
  };
}
