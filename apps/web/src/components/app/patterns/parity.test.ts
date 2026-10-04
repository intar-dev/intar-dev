import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollectionPagination } from "./CollectionPagination";
import { FilterBar, FilterChipGroup } from "./FilterBar";
import { InlineFeedback } from "./InlineFeedback";
import { MetaLine } from "./MetaLine";
import { Stat } from "./Stat";
import { ErrorState } from "./StateCard";
import { StatusToken } from "./StatusToken";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(node);

describe("pattern parity", () => {
  it("announces the whole page range and names the step buttons", () => {
    const out = html(
      createElement(CollectionPagination, {
        page: 2,
        pageSize: 12,
        totalItems: 40,
        itemLabel: "users",
        onPageChange: () => {},
      }),
    );
    expect(out).toContain('aria-atomic="true"');
    expect(out).toContain("13–24");
    expect(out).toContain("of 40 users");
    expect(out).toContain('aria-label="Previous page"');
    expect(out).toContain('aria-label="Next page"');
  });

  it("announces an error card and keeps the retry focusable", () => {
    const out = html(
      createElement(ErrorState, { title: "Could not load", onRetry: () => {} }),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain("Try again");
  });

  it("drops empty items and renders a span inside links", () => {
    expect(html(createElement(MetaLine, { items: ["", "  ", null] }))).toBe("");
    const out = html(createElement(MetaLine, { items: ["a", "", "b"], as: "span" }));
    expect(out.startsWith("<span")).toBe(true);
    expect((out.match(/·/g) ?? []).length).toBe(1);
    // The dot leads the item after it, so it never ends a wrapped line.
    expect(out).toMatch(/<span aria-hidden="true"[^>]*>·<\/span><span[^>]*>b<\/span>/);
  });

  it("links an error to its field and rolls it in", () => {
    const out = html(
      createElement(InlineFeedback, {
        tone: "error",
        id: "e1",
        children: "Too long",
      }),
    );
    expect(out).toContain('id="e1"');
    expect(out).toContain("roll-in");
  });

  it("keeps a live detail mounted on opt-in", () => {
    const out = html(
      createElement(Stat, {
        label: "Left",
        value: "3",
        detail: "Sign-ups are open",
        announce: true,
      }),
    );
    expect(out).toContain('aria-live="polite"');
  });

  it("always mounts the filter count and groups chips by name", () => {
    const bar = html(
      createElement(FilterBar, {
        search: "",
        onSearchChange: () => {},
        shown: 0,
        total: 20,
        noun: "runs",
      }),
    );
    expect(bar).toContain('type="search"');
    expect(bar).toContain('aria-live="polite"');
    expect(bar).toContain("of 20 runs.");
    expect(
      html(createElement(FilterChipGroup, { label: "Filter by outcome", children: null })),
    ).toContain('role="group" aria-label="Filter by outcome"');
  });

  it("stacks every status word and announces through one status region", () => {
    const out = html(
      createElement(StatusToken, {
        tone: "live",
        word: "Running",
        words: ["Starting", "Running", "Solved"],
        live: true,
      }),
    );
    expect(out).toContain("data-swap");
    expect(out.match(/role="status"/g)).toHaveLength(1);
    expect(out).toContain("text-foreground");
  });
});
