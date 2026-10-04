import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detentForSection, RUN_QUERY } from "./run-viewport";

const css = readFileSync(
  new URL("../../../styles/global.css", import.meta.url),
  "utf8",
);

describe("run viewport thresholds", () => {
  it("keeps the matchMedia queries and the Tailwind variants in step", () => {
    expect(css).toContain(`@custom-variant dock (@media ${RUN_QUERY.docked});`);
    expect(css).toContain(`@custom-variant split (@media ${RUN_QUERY.split});`);
    expect(css).toContain(`@custom-variant short (@media ${RUN_QUERY.short});`);
    expect(css).toContain("--breakpoint-run: 60rem;");
  });

  it("peeks at the checks and opens lecture and hints full", () => {
    expect(detentForSection("checks")).toBe("peek");
    expect(detentForSection("lecture")).toBe("full");
    expect(detentForSection("hints")).toBe("full");
  });
});
