import { Outlet } from "@tanstack/react-router";

// The public marketing surface. Shares the one brand identity with the app;
// theme follows the user's choice (or system preference) via <html>.
export function MarketingShell() {
  return (
    <div className="min-h-screen text-foreground">
      <Outlet />
    </div>
  );
}
