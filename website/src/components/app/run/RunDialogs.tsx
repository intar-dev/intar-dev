import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="destructive" className="w-full sm:w-auto">
            <Trash2 className="size-4" />
            Cancel scenario
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this scenario?</DialogTitle>
          <DialogDescription>
            This ends the current run and saves the replay after cleanup
            finishes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Keep going
          </Button>
          <Button
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <Trash2 className="size-4" />
            {props.pending ? "Canceling..." : "Cancel scenario"}
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
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="destructive" className="w-full sm:w-auto">
            <Trash2 className="size-4" />
            Delete run
          </Button>
        }
      />
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
