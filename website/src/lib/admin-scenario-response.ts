import type {
  ScenarioDetailRecord,
  ScenarioListRecord,
} from "@/lib/scenarios";

export function serializeAdminScenarioSummary(scenario: ScenarioListRecord) {
  return {
    scenarioId: scenario.scenarioId,
    title: scenario.title,
    description: scenario.description,
    difficulty: scenario.difficulty,
    estimatedMinutes: scenario.estimatedMinutes,
    tags: scenario.tags,
    briefingMarkdown: scenario.briefingMarkdown,
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
    probes: scenario.probes.map(({ hints, ...probe }) => ({
      ...probe,
      hintCount: hints.length,
    })),
    vms: scenario.vms,
  };
}
