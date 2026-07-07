import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader";

interface PageShellProps {
  title: string;
  description?: string;
  children: ReactNode;
  eyebrow?: string;
  /** Stamp the "Admin workspace" eyebrow + Admin badge (old AuthenticatedShell). */
  admin?: boolean;
  compactHeader?: boolean;
  showHeader?: boolean;
}

// Presentational page shell: the header + centered content region the old
// SignedInShell / AuthenticatedShell wrappers provided, minus the auth
// guard/redirect — that now lives once in the router's beforeLoad. Rendered
// inside the AppShell content region.
export function PageShell({
  title,
  description = "",
  children,
  eyebrow,
  admin = false,
  compactHeader = false,
  showHeader = true,
}: PageShellProps) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6">
      {showHeader ? (
        <PageHeader
          eyebrow={admin ? "Admin workspace" : eyebrow}
          badge={admin ? "Admin" : undefined}
          title={title}
          description={description || undefined}
          compact={compactHeader}
        />
      ) : null}
      <main className="flex flex-1 flex-col gap-6">{children}</main>
    </div>
  );
}
