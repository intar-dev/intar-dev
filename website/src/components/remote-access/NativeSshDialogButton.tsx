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
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Native SSH for {vmName}</DialogTitle>
          <DialogDescription>
            This route accepts one of the Ed25519 keys saved on your profile.
            Use your own local SSH identity and connect through Stargate.
          </DialogDescription>
        </DialogHeader>
        {open ? <NativeSshConnectPanel sessionRequest={sessionRequest} /> : null}
      </DialogContent>
    </Dialog>
  );
}
