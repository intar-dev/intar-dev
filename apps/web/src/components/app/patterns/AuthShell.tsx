import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="relative min-h-svh overflow-hidden px-[var(--page-inset)] py-4 sm:py-6 lg:py-10">
      <div
        className="pointer-events-none absolute inset-x-0 top-16 border-t opacity-60"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-y-0 left-[var(--page-inset)] border-l opacity-40"
        aria-hidden="true"
      />
      <div className="relative mx-auto w-full max-w-5xl">
        <BrandMark className="mb-4 sm:mb-6" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-center lg:gap-12">
          <section className="order-1 rounded-xl border bg-card p-4 shadow-sm sm:p-8 lg:order-2">
            <header className="space-y-2">
              <p className="text-eyebrow">{eyebrow}</p>
              <h1 className="text-page-title">{title}</h1>
              <p className="text-body text-muted-foreground">{description}</p>
            </header>
            <div className="mt-8">{children}</div>
          </section>

          <div className="order-2 flex max-w-lg flex-col items-start gap-4 lg:order-1 lg:gap-8">
            <div className="space-y-4">
              <p className="text-eyebrow">Systems workshop access</p>
              <p className="font-heading text-xl leading-tight font-bold tracking-[-0.03em] text-balance lg:text-4xl lg:tracking-[-0.035em]">
                One identity from briefing to verified repair.
              </p>
              <p className="prose-measure text-sm leading-6 text-muted-foreground lg:text-base lg:leading-7">
                intar.dev uses GitHub identity so your scenarios, terminal
                sessions, and run history stay connected.
              </p>
            </div>
            <ol className="hidden w-full border-y text-sm lg:block">
              {[
                [
                  "01",
                  "Authenticate",
                  "Confirm the GitHub identity you work with.",
                ],
                [
                  "02",
                  "Enter the workshop",
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
                  className="grid grid-cols-[2.5rem_8rem_1fr] gap-3 border-b py-3 last:border-b-0"
                >
                  <span className="font-heading text-xs font-semibold text-brand-text tabular-nums">
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
