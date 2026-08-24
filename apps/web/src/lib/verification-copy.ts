export interface VerificationObjectiveCopy {
  probeName: string;
  title: string | null;
}

export function repairObjectiveTitle(
  objective: VerificationObjectiveCopy | null | undefined,
  index: number,
) {
  return objective?.title?.trim() || `Repair objective ${index + 1}`;
}

export function verificationStatusLabel(status: string) {
  return isVerificationPassed(status) ? "Verified" : "Needs repair";
}

export function isVerificationPassed(status: string | null | undefined) {
  switch (status?.trim().toLowerCase()) {
    case "pass":
    case "passed":
    case "passing":
    case "ready":
    case "ok":
    case "success":
    case "succeeded":
      return true;
    default:
      return false;
  }
}

export function buildVerificationLabelMap(input: {
  bootProbeIds: readonly string[];
  scenarioProbeIds: readonly string[];
  objectives: readonly VerificationObjectiveCopy[];
}) {
  const labels: Record<string, string> = {};
  for (const [index, probeId] of uniqueIds(input.bootProbeIds).entries()) {
    labels[probeId] = `Startup check ${index + 1}`;
  }

  const objectiveIndexes = new Map(
    input.objectives.map((objective, index) => [objective.probeName, index]),
  );
  let unmatchedCount = 0;
  for (const probeId of uniqueIds(input.scenarioProbeIds)) {
    const objectiveIndex = objectiveIndexes.get(probeId);
    if (objectiveIndex !== undefined) {
      labels[probeId] = repairObjectiveTitle(
        input.objectives[objectiveIndex],
        objectiveIndex,
      );
      continue;
    }
    labels[probeId] = `Repair objective ${
      input.objectives.length + unmatchedCount + 1
    }`;
    unmatchedCount += 1;
  }
  return labels;
}

function uniqueIds(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.trim()))];
}
