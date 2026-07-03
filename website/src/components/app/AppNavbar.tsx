import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { authClient, startGithubSignIn } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { useSession } from "./hooks/useSession";

const navItems = [
  { id: "home", label: "Home", to: "/" as const },
  { id: "scenarios", label: "Scenarios", to: "/scenarios" as const },
  { id: "overview", label: "Overview", to: "/dashboard" as const },
  {
    id: "admin-builds",
    label: "Builds",
    to: "/admin/builds" as const,
  },
  {
    id: "admin-scenarios",
    label: "Scenario Registry",
    to: "/admin/scenarios" as const,
  },
] as const;

export function AppNavbar() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data, isLoading, refetch } = useSession();
  const user = data?.user ?? null;
  const isAdmin = isAdminUser(user);
  const current = resolveCurrentNav(pathname);

  const signIn = useMutation({
    mutationFn: () =>
      startGithubSignIn({
        callbackURL: `${window.location.origin}/scenarios`,
        errorCallbackURL: `${window.location.origin}/`,
      }),
  });

  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if ("error" in result && result.error) {
        throw new Error(result.error.message ?? "Failed to sign out");
      }
      return result;
    },
    onSuccess: async () => {
      await refetch();
      void navigate({ to: "/" });
    },
  });

  return (
    <header className="sticky top-0 z-40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 pr-16 sm:px-6 sm:pr-16 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:pr-16">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
          <Link to="/" className="text-base font-semibold tracking-tight">
            intar.dev
          </Link>

          {user ? (
            <nav className="flex min-w-0 flex-wrap gap-2">
              {navItems
                .filter(
                  (item) =>
                    item.id === "home" || item.id === "scenarios" || isAdmin,
                )
                .map((item) => (
                  <Link
                    key={item.id}
                    to={item.to}
                    className={cn(
                      buttonVariants({
                        variant: current === item.id ? "secondary" : "ghost",
                        size: "sm",
                      }),
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
            </nav>
          ) : null}
        </div>

        {user ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button
              asChild
              type="button"
              variant={pathname.startsWith("/profile") ? "secondary" : "ghost"}
              size="sm"
            >
              <Link to="/profile">
                {user.username ?? "Anonymous"}
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              {signOut.isPending ? "Signing out..." : "Sign out"}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => signIn.mutate()}
            disabled={isLoading || signIn.isPending}
          >
            {signIn.isPending
              ? "Opening GitHub..."
              : isLoading
                ? "Checking access..."
                : "Enter platform"}
          </Button>
        )}
      </div>
    </header>
  );
}

function resolveCurrentNav(pathname: string) {
  if (pathname.startsWith("/profile")) {
    return "profile";
  }

  if (pathname.startsWith("/admin/scenarios")) {
    return "admin-scenarios";
  }

  if (pathname.startsWith("/admin/builds")) {
    return "admin-builds";
  }

  if (pathname.startsWith("/scenarios")) {
    return "scenarios";
  }

  if (pathname.startsWith("/dashboard")) {
    return "overview";
  }

  return "home";
}
