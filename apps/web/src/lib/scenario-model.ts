export type ScenarioDifficulty = "easy" | "medium" | "hard";

export function parseScenarioDifficulty(
  value: string,
): ScenarioDifficulty | null {
  return value === "easy" || value === "medium" || value === "hard"
    ? value
    : null;
}

export interface ScenarioObjective {
  probeName: string;
  vmName: string;
  label: string;
  title: string | null;
  bodyMarkdown: string | null;
  hintCount: number;
}

export interface ScenarioLaunchProbeDescriptor {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
}

export interface ScenarioLaunchSummary {
  scenarioVmName: string;
  hostname: string;
  probePhaseMap: Record<string, "boot" | "scenario">;
  probeDescriptors: ScenarioLaunchProbeDescriptor[];
}
