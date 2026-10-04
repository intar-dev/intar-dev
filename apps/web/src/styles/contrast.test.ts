import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// axe checks rendered text, but not hover fills or control edges (WCAG
// 1.4.11). These pairs are the thinnest in the palette, so pin them here.
const css = readFileSync(new URL("./global.css", import.meta.url), "utf8");

function tokens(selector: string) {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

function luminance(hex: string) {
  const channel = (offset: number) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const text = [
  ["faint-foreground", "canvas"],
  ["faint-foreground", "muted"],
  ["faint-foreground", "accent"],
  ["faint-foreground", "sidebar-accent"],
  ["muted-foreground", "accent"],
  ["warning", "warning-subtle"],
  ["brand-text", "card"],
] as const;
const edges = [
  ["input", "card"],
  ["input", "background"],
  ["border-strong", "card"],
] as const;

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
])("%s palette", (_, selector) => {
  const t = tokens(selector);

  it.each(text)("%s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(t[fg] ?? "", t[bg] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it.each(edges)("%s against %s reaches 3:1", (edge, bg) => {
    expect(contrast(t[edge] ?? "", t[bg] ?? "")).toBeGreaterThanOrEqual(3);
  });
});
