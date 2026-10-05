import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { CopyButton } from "@/components/app/patterns/CopyButton";
import { Field } from "@/components/app/patterns/Field";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Turns public sharing of a run on and off. Sharing is the learner's explicit
 * choice, so nothing is shared until Share is pressed; while it is on, the
 * link is here to copy, and stopping ends it for everyone who has it.
 */
export function RunShareDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The public link while the run is shared; null while it is not. */
  url: string | null;
  pending: boolean;
  error: string | null;
  onShare: () => void;
  onStop: () => void;
}) {
  const safeAction = useRef<HTMLButtonElement>(null);
  const shareAction = useRef<HTMLButtonElement>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  // Pressing Share or Stop swaps the button that holds focus for the other
  // state's controls; focus follows to where the next step is.
  const shared = props.url !== null;
  const wasShared = useRef(shared);
  useEffect(() => {
    if (wasShared.current === shared) return;
    wasShared.current = shared;
    setCopyFailed(false);
    if (!props.open) return;
    if (shared) {
      linkField.current?.focus();
      linkField.current?.select();
    } else {
      shareAction.current?.focus();
    }
  }, [shared, props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        // Escape and the backdrop wait while the request runs.
        if (!open && props.pending) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Opened on a shared run, the link is what the learner came for.
        initialFocus={shared ? linkField : safeAction}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {shared ? "This run is shared" : "Share this run"}
          </DialogTitle>
          <DialogDescription>
            Anyone with the link can watch this run's terminals (web and SSH)
            and read the mission. Typed input appears where the terminal echoes
            it.
          </DialogDescription>
        </DialogHeader>

        {props.url ? (
          <div className="space-y-3">
            <Field label="Public link">
              {(control) => (
                <div className="space-y-2">
                  <Input
                    {...control}
                    ref={linkField}
                    readOnly
                    mono
                    value={props.url ?? ""}
                    className="max-w-none"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <div className="flex flex-wrap gap-2">
                    <CopyButton
                      text={props.url ?? ""}
                      name="Copy the public link"
                      size="default"
                      onError={() => {
                        setCopyFailed(true);
                        linkField.current?.focus();
                        linkField.current?.select();
                      }}
                    />
                    <Button
                      variant="outline"
                      render={
                        <a
                          href={props.url ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      }
                    >
                      <ExternalLink aria-hidden="true" />
                      Open
                      <span className="sr-only"> in a new tab</span>
                    </Button>
                  </div>
                </div>
              )}
            </Field>
            {copyFailed ? (
              <InlineFeedback tone="error">
                Could not copy automatically. The link is selected: press
                Ctrl+C, or ⌘C on a Mac.
              </InlineFeedback>
            ) : null}
            <p className="text-metadata">
              Stopping ends the link for everyone watching. Sharing again
              creates a new link.
            </p>
          </div>
        ) : null}

        {props.error ? (
          <Alert variant="destructive" just>
            <AlertTitle>
              {shared ? "Could not stop sharing" : "Could not share this run"}
            </AlertTitle>
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {shared ? (
            <>
              <Button
                variant="destructive"
                disabled={props.pending}
                focusableWhenDisabled
                aria-busy={props.pending || undefined}
                onClick={props.onStop}
              >
                <AsyncLabel
                  state={props.pending ? "pending" : "idle"}
                  idle="Stop sharing"
                  pending="Stopping…"
                />
              </Button>
              <Button
                ref={safeAction}
                variant="outline"
                disabled={props.pending}
                onClick={() => props.onOpenChange(false)}
              >
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                ref={safeAction}
                variant="outline"
                disabled={props.pending}
                onClick={() => props.onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                ref={shareAction}
                disabled={props.pending}
                focusableWhenDisabled
                aria-busy={props.pending || undefined}
                onClick={props.onShare}
              >
                <AsyncLabel
                  state={props.pending ? "pending" : "idle"}
                  idle="Share"
                  pending="Creating link…"
                />
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
