import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageShell } from "./PageShell";

describe("PageShell", () => {
  it("keeps page and workspace content fluid", () => {
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
    expect(page).not.toContain("max-w-");
    expect(workspace).not.toContain("max-w-");
  });
});
