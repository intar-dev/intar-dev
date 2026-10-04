import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

export function AuthShell({
  eyebrow,
  title,
  description,
  standalone = false,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  standalone?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="relative min-h-dvh overflow-hidden pt-[env(safe-area-inset-top)] pr-[max(var(--page-inset),env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(var(--page-inset),env(safe-area-inset-left))] lg:pb-8">
      <div
        className="pointer-events-none absolute inset-x-0 top-16 border-t"
        aria-hidden="true"
      />
      <div className="relative mx-auto w-full max-w-5xl">
        {/* A 4rem band keeps the mark above the top-16 rule at every width. */}
        <div className="mb-6 flex h-16 items-center">
          <BrandMark native={standalone} />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-center lg:gap-8">
          <section className="order-1 surface-raised rounded-xl border p-5 sm:p-6 lg:order-2">
            <header className="space-y-2">
              <p className="text-label">{eyebrow}</p>
              <h1 className="text-page-title">{title}</h1>
              <p className="text-body text-muted-foreground">{description}</p>
            </header>
            <div className="mt-6">{children}</div>
          </section>

          <div className="order-2 flex max-w-lg flex-col items-start gap-4 lg:order-1 lg:gap-6">
            <div className="space-y-4">
              <p className="text-label">Systems training access</p>
              <p className="text-feature-title text-balance">
                One identity from briefing to verified repair.
              </p>
              <p className="prose-measure text-support text-muted-foreground">
                intar.dev uses GitHub identity so your scenarios, terminal
                sessions, and run history stay connected.
              </p>
            </div>
            <ol className="hidden w-full border-y text-support lg:block">
              {[
                [
                  "01",
                  "Authenticate",
                  "Confirm the GitHub identity you work with.",
                ],
                [
                  "02",
                  "Start the work",
                  "Open an assigned or self-directed scenario.",
                ],
                [
                  "03",
                  "Keep your record",
                  "Return to active work and completed replays.",
                ],
              ].map(([number, label, detail]) => (
                <li
                  key={number}
                  className="grid grid-cols-[2.5rem_8rem_1fr] items-baseline gap-3 border-b py-3 last:border-b-0"
                >
                  <span className="font-heading text-label font-semibold text-brand-text tabular-nums">
                    {number}
                  </span>
                  <span className="font-semibold">{label}</span>
                  <span className="text-muted-foreground">{detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </main>
  );
}
