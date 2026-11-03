import { Outlet } from "@tanstack/react-router";
import { CutoverBanner } from "./CutoverBanner";

// The public marketing surface. Shares the one brand identity with the app;
// theme follows the user's choice (or system preference) via <html>.
export function MarketingShell() {
  return (
    <div className="min-h-dvh text-foreground">
      <CutoverBanner />
      <Outlet />
    </div>
  );
}
