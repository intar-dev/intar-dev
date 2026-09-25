import type { ReactNode } from "react";
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
 * Asks before a destructive action and shows its failure in place. A pending
 * action keeps the dialog open until it settles, so its result always shows.
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
  confirmDisabled?: boolean;
  onConfirm: () => void;
}) {
  const close = () => {
    if (!props.pending) props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {props.error ? (
          <InlineFeedback tone="error">{props.error}</InlineFeedback>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={props.pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={props.pending || props.confirmDisabled}
            onClick={props.onConfirm}
          >
            {props.pending ? props.pendingLabel : props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
