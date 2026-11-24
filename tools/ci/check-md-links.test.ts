import { expect, test } from "bun:test";
import { relativeLinks, resolve } from "./check-md-links";

test("takes repository paths and leaves web links, anchors and code alone", () => {
  const markdown = [
    "[a](../a.md#part) [b](https://example.com) [c](#here) [d](<with space.md>)",
    "`[e](in-code.md)`",
    "```",
    "[f](in-fence.md)",
    "```",
    '[g](/root.md "title")',
  ].join("\n");
  expect(relativeLinks(markdown)).toEqual(["../a.md", "with space.md", "/root.md"]);
});

test("resolves against the file, or the root for a leading slash", () => {
  expect(resolve("apps/web/README.md", "../../ci/README.md")).toBe("ci/README.md");
  expect(resolve("apps/web/README.md", "/AGENTS.md")).toBe("AGENTS.md");
  expect(resolve("README.md", "reports/a%20b.md")).toBe("reports/a b.md");
});
