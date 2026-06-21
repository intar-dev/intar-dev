import type { ReactNode } from "react";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isAdminUser } from "@/lib/authz";
import { useSession } from "./hooks/useSession";

interface AuthenticatedShellProps {
  title: string;
  description: string;
  children: ReactNode;
}

export function AuthenticatedShell({
  title,
  description,
  children,
}: AuthenticatedShellProps) {
  const navigate = useNavigate();
  const { data, isLoading } = useSession();
  const user = data?.user ?? null;
  const isAdmin = isAdminUser(user);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!user || !isAdmin) {
      void navigate({ to: "/", replace: true });
    }
  }, [isAdmin, isLoading, navigate, user]);

  if (!user || !isAdmin) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 sm:px-6 lg:px-8">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-base">Checking access</CardTitle>
            <CardDescription>
              {isLoading ? "Checking your session..." : "Redirecting..."}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] px-4 py-6 sm:px-6 lg:px-8">
      <div
        className="mx-auto flex w-full max-w-7xl flex-col gap-6"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-muted-foreground">
              Admin workspace
            </p>
            <Badge variant="secondary">Admin</Badge>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              {title}
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
              {description}
            </p>
          </div>
        </div>

        <main className="flex flex-1 flex-col gap-6">{children}</main>
      </div>
    </div>
  );
}
