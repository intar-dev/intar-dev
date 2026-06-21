import type { ReactNode } from "react";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { useSession } from "./hooks/useSession";

interface SignedInShellProps {
  title: string;
  description: string;
  children: ReactNode;
  eyebrow?: string;
  compactHeader?: boolean;
  showHeader?: boolean;
}

export function SignedInShell({
  title,
  description,
  children,
  eyebrow = "",
  compactHeader = false,
  showHeader = true,
}: SignedInShellProps) {
  const navigate = useNavigate();
  const { data, isLoading } = useSession();
  const user = data?.user ?? null;

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!user) {
      void navigate({ to: "/", replace: true });
    }
  }, [isLoading, navigate, user]);

  if (!user) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 sm:px-6 lg:px-8">
        <Card className="w-full max-w-md">
          <CardContent
            className="py-6 text-sm text-muted-foreground"
            aria-live="polite"
          >
            {isLoading ? "Checking access..." : "Redirecting..."}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] px-4 py-6 sm:px-6 lg:px-8">
      <div
        className="mx-auto flex w-full max-w-7xl flex-col gap-6"
      >
        {showHeader ? (
          <div className="space-y-3">
            {eyebrow ? (
              <p className="text-sm font-medium text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            <div className="space-y-2">
              <h1
                className={cn(
                  "font-semibold tracking-tight",
                  compactHeader ? "text-3xl" : "text-4xl sm:text-5xl",
                )}
              >
                {title}
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                {description}
              </p>
            </div>
          </div>
        ) : null}

        <main className="flex flex-1 flex-col gap-6">{children}</main>
      </div>
    </div>
  );
}
