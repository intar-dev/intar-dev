import { Button } from "@/components/ui/button";
import { useNewReleaseAvailable } from "../lib/release-check";

/** Offers the deployed release once this tab runs an older one. */
export function NewVersionButton() {
  const available = useNewReleaseAvailable();
  if (!available) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      title="Reload to get the new version"
      onClick={() => window.location.reload()}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full bg-primary motion-safe:animate-live"
      />
      New version
      <span className="sr-only">{" available, reload to update"}</span>
    </Button>
  );
}
