import { useRef } from "react";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { BinIcon } from "@/components/ui/bin-icon";
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
  const safeAction = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        // Escape and the backdrop wait while the request runs.
        if (!open && props.pending) return;
        props.onOpenChange(open);
      }}
    >
      {(props.trigger ?? true) ? (
        <DialogTrigger
          render={
            <Button size="sm" variant="destructive" className="w-full sm:w-auto">
              <BinIcon />
              End run
            </Button>
          }
        />
      ) : null}
      <DialogContent showCloseButton={false} initialFocus={safeAction}>
        <DialogHeader>
          <DialogTitle>
            {props.retry ? "Retry ending this run?" : "End this run?"}
          </DialogTitle>
          <DialogDescription>
            {props.retry
              ? "The earlier request did not finish. Try again to close the run and save your work."
              : "This closes the terminal and saves your result and replay."}
          </DialogDescription>
        </DialogHeader>
        {props.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not end run</AlertTitle>
            <AlertDescription>
              {props.error} Try ending the run again.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            ref={safeAction}
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.pending}
          >
            Keep going
          </Button>
          <Button
            variant="danger"
            onClick={props.onConfirm}
            disabled={props.pending}
            focusableWhenDisabled
            aria-busy={props.pending || undefined}
          >
            <BinIcon />
            <AsyncLabel
              state={props.pending ? "pending" : "idle"}
              idle={props.retry ? "Retry end" : "End run"}
              pending="Ending run…"
            />
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
  error?: boolean;
  /** Render the inline trigger button; false when the app bar opens it. */
  trigger?: boolean;
}) {
  const safeAction = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && props.pending) return;
        props.onOpenChange(open);
      }}
    >
      {(props.trigger ?? true) ? (
        <DialogTrigger
          render={
            <Button size="sm" variant="destructive" className="w-full sm:w-auto">
              <BinIcon />
              Delete run
            </Button>
          }
        />
      ) : null}
      <DialogContent showCloseButton={false} initialFocus={safeAction}>
        <DialogHeader>
          <DialogTitle>Delete this run?</DialogTitle>
          <DialogDescription>
            This removes the run and everything saved with it from your history.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {props.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not delete run</AlertTitle>
            <AlertDescription>
              Nothing was removed. Try again when you are ready.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            ref={safeAction}
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.pending}
          >
            Keep run
          </Button>
          <Button
            variant="danger"
            onClick={props.onConfirm}
            disabled={props.pending}
            focusableWhenDisabled
            aria-busy={props.pending || undefined}
          >
            <BinIcon />
            <AsyncLabel
              state={props.pending ? "pending" : "idle"}
              idle="Delete run"
              pending="Deleting…"
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
