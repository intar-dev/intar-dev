import { BookOpen, SquareTerminal } from "lucide-react";

export function LectureScenarioLabel({
  scenarioId,
}: {
  scenarioId: string | null;
}) {
  const includesScenario = Boolean(scenarioId);
  const Icon = includesScenario ? SquareTerminal : BookOpen;

  return (
    <span
      className="inline-flex items-center gap-1"
      title={
        includesScenario
          ? "This lecture includes a scenario."
          : "This lecture does not include a scenario."
      }
    >
      <Icon className="size-3.5" aria-hidden />
      {includesScenario ? "Scenario" : "Lecture only"}
    </span>
  );
}
