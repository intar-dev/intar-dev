import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  NativeSshConnectPanel,
  type NativeSshSessionRequest,
} from "./NativeSshConnectPanel";

interface NativeSshDialogButtonProps {
  vmName: string;
  sessionRequest: NativeSshSessionRequest;
  disabled?: boolean;
  label?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
}

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

// Thin dialog wrapper around NativeSshConnectPanel — the panel issues the
// session when the dialog content mounts.
export function NativeSshDialogButton({
  vmName,
  sessionRequest,
  disabled = false,
  label = "Native SSH",
  size = "sm",
  variant = "outline",
  className,
}: NativeSshDialogButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            size={size}
            variant={variant}
            className={className}
            disabled={disabled}
          >
            {label}
          </Button>
        }
      />
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
