import { SideSheet } from "@/components/app/patterns/SideSheet";
import {
  NativeSshConnectPanel,
  type NativeSshSessionRequest,
} from "./NativeSshConnectPanel";

// Controlled, with no trigger of its own: opened from a menu item or a button.
export function NativeSshSheet({
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
    <SideSheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={`Native SSH for ${vmName}`}
      description="Use a saved public key, or create a temporary key for this run. Temporary private keys stay in this tab through refreshes and are never saved to your profile. They are removed when the route expires."
      data-native-ssh-sheet
    >
      {/* Always rendered: the panel keeps its content through the exit, and
          Base UI unmounts the popup afterwards, so each open starts fresh. */}
      <NativeSshConnectPanel sessionRequest={sessionRequest} />
    </SideSheet>
  );
}
