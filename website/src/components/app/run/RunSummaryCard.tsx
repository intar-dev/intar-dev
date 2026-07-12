import { Card, CardContent } from "@/components/ui/card";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { formatScenarioDurationMs } from "./run-support";

// First rail section: the frame has no page header, so the full scenario
// name (the bar crumb truncates) and its facts anchor the console here.
export function RunSummaryCard(props: {
  scenarioName: string;
  vmCount: number;
  solveDurationMs: number | null;
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1.5">
        <p className="text-sm font-semibold text-balance">
          {props.scenarioName}
        </p>
        <MetaLine
          items={[
            props.vmCount === 1 ? "1 machine" : `${props.vmCount} machines`,
            props.solveDurationMs !== null
              ? `solved in ${formatScenarioDurationMs(props.solveDurationMs)}`
              : null,
          ]}
        />
      </CardContent>
    </Card>
  );
}
