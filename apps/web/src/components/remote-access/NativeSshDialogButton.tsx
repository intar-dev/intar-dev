import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NativeSshConnectPanel,
  type NativeSshSessionRequest,
} from "./NativeSshConnectPanel";

// Controlled variant with no trigger of its own — opened from a menu item.
export function NativeSshDialog({
  vmName,
  sessionRequest,
  open,
  onOpenChange,
}: {
  vmName: string;
  sessionRequest: NativeSshSessionRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Native SSH for {vmName}</DialogTitle>
          <DialogDescription>
            Use a saved public key, or create a temporary key for this run.
            Temporary private keys stay in this tab through refreshes and are
            never saved to your profile. They are removed when the route
            expires.
          </DialogDescription>
        </DialogHeader>
        {open ? <NativeSshConnectPanel sessionRequest={sessionRequest} /> : null}
      </DialogContent>
    </Dialog>
  );
}
