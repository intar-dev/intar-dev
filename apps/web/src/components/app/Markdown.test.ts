import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown page headings", () => {
  it("keeps authored headings below the app bar h1", () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, {
        pageContent: true,
        children: "# Course title\n\n## Theory\n\n### Detail",
      }),
    );

    expect(markup).not.toContain("<h1");
    expect(markup.match(/<h2/g)).toHaveLength(2);
    expect(markup).toContain("<h3");
  });
});
