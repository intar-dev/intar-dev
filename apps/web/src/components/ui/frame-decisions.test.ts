import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Plus, ArrowRight } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Hint, WhyDisabled } from "@/components/app/patterns/Hint";
import { Button } from "./button";

const attr = /\sdata-icon-(start|end)="/;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);

describe("Button icon sides", () => {
  it("trims the side an icon sits on", () => {
    const lead = html(createElement(Button, null, createElement(Plus), "New"));
    expect(lead).toContain(' data-icon-start="');
    expect(lead).not.toContain(' data-icon-end="');

    const trail = html(createElement(Button, null, "Next", createElement(ArrowRight)));
    expect(trail).toContain(' data-icon-end="');
    expect(trail).not.toContain(' data-icon-start="');

    const both = html(
      createElement(Button, null, createElement(Plus), "Both", createElement(ArrowRight)),
    );
    expect(both).toContain(' data-icon-start="');
    expect(both).toContain(' data-icon-end="');
  });

  it("leaves labels, icon-only buttons and links alone", () => {
    expect(html(createElement(Button, null, "Label"))).not.toMatch(attr);
    expect(
      html(createElement(Button, { size: "icon" }, createElement(Plus))),
    ).not.toMatch(attr);
    expect(
      html(createElement(Button, { variant: "link" }, createElement(Plus), "Docs")),
    ).not.toMatch(attr);
    // A host element is not an icon.
    expect(
      html(createElement(Button, null, createElement("span", null, "x"), "y")),
    ).not.toMatch(attr);
  });

  it("trims the padding on that side only", () => {
    const out = html(createElement(Button, null, createElement(Plus), "New"));
    expect(out).toContain("data-icon-start:pl-3");
    expect(out).toContain("data-icon-end:pr-3");
  });
});

describe("Hint", () => {
  it("takes a tab stop and describes the element when it holds essential text", () => {
    const out = html(
      createElement(Hint, {
        label: "4 Oct 2026, 12:00",
        essential: true,
        render: createElement("time"),
        children: "2 minutes ago",
      }),
    );
    expect(out).toContain('tabindex="0"');
    expect(out).toMatch(/aria-describedby="([^"]+)"/);
    expect(out).toContain("4 Oct 2026, 12:00</span>");
    expect(out).not.toContain("title=");
  });

  it("stays out of the tab order when it only repeats truncated text", () => {
    const out = html(
      createElement(Hint, {
        label: "A long name",
        render: createElement("p"),
        children: "A lo…",
      }),
    );
    expect(out).not.toContain("tabindex");
    expect(out).not.toContain("aria-describedby");
  });

  it("explains a disabled control through its wrapper", () => {
    const button = createElement(Button, { disabled: true, children: "Open" });
    const out = html(
      createElement(WhyDisabled, { reason: "Bootstrap pending", children: button }),
    );
    expect(out).toMatch(/<span class="inline-flex"[^>]*tabindex="0"/);
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Bootstrap pending"');
    const free = html(createElement(WhyDisabled, { children: button }));
    expect(free).not.toMatch(/<span class="inline-flex"[^>]*tabindex/);
    expect(free).not.toContain("role=");
  });
});

describe("design tokens and reduced motion", () => {
  const css = readFileSync(new URL("../../styles/global.css", import.meta.url), "utf8");

  it("uses the design system's warning-subtle", () => {
    expect(css).toMatch(/--warning-subtle: #f3ede5;/);
    expect(css).toMatch(/--warning-subtle: #343028;/);
  });

  it("keeps the outline ghost and checks segments fading under reduced motion", () => {
    const layered = css.slice(css.indexOf("@layer base {\n  @media (prefers-reduced-motion: reduce) {\n    [data-nav-ghost]"));
    expect(layered).toMatch(
      /\[data-outline-ghost\] \{\s*transition-property: opacity !important;\s*transition-duration: var\(--duration-fast\) !important;/,
    );
    expect(layered).toMatch(
      /\[data-checks-bar\] > span \{\s*transition-property: background-color !important;\s*transition-duration: var\(--duration-reveal\) !important;/,
    );
  });
});
