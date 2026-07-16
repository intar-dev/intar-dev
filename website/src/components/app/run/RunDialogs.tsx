import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ScenarioCancelDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  error?: string | null;
  retry?: boolean;
  /** Render the inline trigger button; false when the app bar opens it. */
  trigger?: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {(props.trigger ?? true) ? (
        <DialogTrigger
          render={
            <Button size="sm" variant="destructive" className="w-full sm:w-auto">
              <Trash2 className="size-4" />
              End run
            </Button>
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {props.retry ? "Retry ending this run?" : "End this run?"}
          </DialogTitle>
          <DialogDescription>
            {props.retry
              ? "The earlier request did not release this run. Retry route revocation and cleanup acceptance now."
              : "The sandbox will shut down and the terminal session will close. Run history and replay data are kept after cleanup finishes."}
          </DialogDescription>
        </DialogHeader>
        {props.error ? (
          <Alert variant="destructive">
            <AlertTitle>Run could not be ended</AlertTitle>
            <AlertDescription>
              {props.error} This run still owns your active slot; retry when
              ready.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.pending}
          >
            Keep going
          </Button>
          <Button
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <Trash2 className="size-4" />
            {props.pending
              ? "Ending run…"
              : props.retry
                ? "Retry end"
                : "End run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteRunDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  /** Render the inline trigger button; false when the app bar opens it. */
  trigger?: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {(props.trigger ?? true) ? (
        <DialogTrigger
          render={
            <Button size="sm" variant="destructive" className="w-full sm:w-auto">
              <Trash2 className="size-4" />
              Delete run
            </Button>
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this run?</DialogTitle>
          <DialogDescription>
            This removes the run and everything saved with it from your history.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Keep run
          </Button>
          <Button
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <Trash2 className="size-4" />
            {props.pending ? "Deleting..." : "Delete run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
