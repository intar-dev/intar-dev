import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// The scenario data cutover (intar-dev/intar-dev#300). The cutover PR removes
// it. A note, not a status: it is on the page from load, and pages keep
// role="status" for their own feedback.
export function CutoverNotice({ className }: { className?: string }) {
  return (
    <Alert
      variant="warning"
      role="note"
      aria-label="Cutover notice"
      className={className}
    >
      <AlertTitle>A cutover is coming in the next two weeks.</AlertTitle>
      <AlertDescription>
        Scenario data will be deleted: runs, replays, shares, course progress
        and assignments. Your account, organizations and servers stay.
      </AlertDescription>
    </Alert>
  );
}
