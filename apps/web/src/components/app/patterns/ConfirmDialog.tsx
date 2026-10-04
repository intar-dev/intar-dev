import { useRef, type ReactNode } from "react";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Asks before a consequential action and shows its failure in place. A pending
 * action keeps the dialog open until it settles, so its result always shows.
 * The confirm button is a danger button unless the action gives something
 * back rather than taking it away.
 */
export function ConfirmDialog(props: {
  open: boolean;
  /** Closes the dialog; ignored while the action is pending. */
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  error: string | null;
  pending: boolean;
  confirmLabel: string;
  pendingLabel: string;
  confirmDisabled?: boolean | undefined;
  confirmVariant?: "danger" | "default" | undefined;
  cancelLabel?: string | undefined;
  /** Details shown between the description and any error. */
  children?: ReactNode;
  contentClassName?: string | undefined;
  /** Where focus goes after the dialog closes (the next row once the trigger's row is gone). */
  finalFocus?: DialogPrimitive.Popup.Props["finalFocus"];
  onConfirm: () => void;
}) {
  const close = () => {
    if (!props.pending) props.onClose();
  };
  // Focus lands on the safe action; a dialog with a field of its own keeps it there.
  const safeAction = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className={props.contentClassName}
        showCloseButton={false}
        finalFocus={props.finalFocus}
        initialFocus={props.children ? undefined : safeAction}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {props.children}
        {props.error ? (
          <InlineFeedback tone="error">{props.error}</InlineFeedback>
        ) : null}
        <DialogFooter>
          <Button
            ref={safeAction}
            variant="outline"
            disabled={props.pending}
            onClick={close}
          >
            {props.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={props.confirmVariant ?? "danger"}
            disabled={props.pending || props.confirmDisabled}
            focusableWhenDisabled={props.pending}
            aria-busy={props.pending || undefined}
            onClick={props.onConfirm}
          >
            <AsyncLabel
              state={props.pending ? "pending" : "idle"}
              idle={props.confirmLabel}
              pending={props.pendingLabel}
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
