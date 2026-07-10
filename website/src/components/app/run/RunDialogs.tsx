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
            End run
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End this run?</DialogTitle>
          <DialogDescription>
            The sandbox will shut down and the terminal session will close.
            Run history and replay data are kept after cleanup finishes.
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
            {props.pending ? "Ending run…" : "End run"}
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
