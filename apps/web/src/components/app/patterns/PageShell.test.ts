import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageShell } from "./PageShell";

describe("PageShell", () => {
  it("keeps page and workspace content fluid up to app-max", () => {
    const page = renderToStaticMarkup(
      createElement(PageShell, {
        children: createElement("p", null, "Page"),
      }),
    );
    const workspace = renderToStaticMarkup(
      createElement(PageShell, {
        variant: "workspace",
        children: createElement("p", null, "Workspace"),
      }),
    );

    expect(page).toContain('data-page-variant="page"');
    expect(workspace).toContain('data-page-variant="workspace"');
    // The padded outer div stays fluid; only the inner column stops at app-max.
    expect(page).toContain("max-w-(--app-max)");
    expect(workspace).toContain("max-w-(--app-max)");
  });
});
