import { Link, useRouterState } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const items = [
  {
    id: "overview",
    label: "Overview",
    to: "/dashboard" as const,
  },
  {
    id: "onboarding",
    label: "Host onboarding",
    to: "/dashboard/onboarding" as const,
  },
] as const;

export function AdminWorkspaceNav() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const current = pathname.startsWith("/dashboard/onboarding")
    ? "onboarding"
    : "overview";

  return (
    <nav
      aria-label="Admin workspace sections"
      className="inline-flex w-fit flex-wrap gap-1 rounded-full border border-border/70 bg-muted/30 p-1"
    >
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          className={cn(
            buttonVariants({
              variant: current === item.id ? "secondary" : "ghost",
              size: "sm",
            }),
            "rounded-full",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
