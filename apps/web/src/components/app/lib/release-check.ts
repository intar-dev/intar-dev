import { useEffect, useState } from "react";

/** The release this bundle was built from: the deployed commit. */
const RUNNING_RELEASE =
  import.meta.env.PUBLIC_RELEASE_VERSION || "development";
const CHECK_INTERVAL_MS = 30 * 60_000;
// A tab switched back and forth checks at most this often.
const CHECK_MIN_GAP_MS = 5 * 60_000;

async function fetchDeployedRelease(): Promise<string | null> {
  try {
    const response = await fetch("/version.json", { cache: "no-cache" });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version
      ? body.version
      : null;
  } catch {
    // Offline or mid-deploy: try again on the next check.
    return null;
  }
}

/**
 * True once the deployment serves a different release than this tab runs.
 * /version.json is a static asset, so a check never invokes the Worker. It is
 * read on mount, when the tab becomes visible again, and every 30 minutes
 * while visible, and never again once an update is known.
 */
export function useNewReleaseAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (available) return;
    let disposed = false;
    let lastCheckAt: number | null = null;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (lastCheckAt !== null && now - lastCheckAt < CHECK_MIN_GAP_MS) return;
      lastCheckAt = now;
      const deployed = await fetchDeployedRelease();
      if (!disposed && deployed !== null && deployed !== RUNNING_RELEASE) {
        setAvailable(true);
      }
    };
    void check();
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
    };
  }, [available]);

  return available;
}
