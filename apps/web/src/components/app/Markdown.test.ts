import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown page headings", () => {
  it("renders forum text and code without HTML, images, or unsafe links", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, {
      textOnly: true,
      pageContent: true,
      children: '# Report\n\n<script>alert(1)</script>\n\n<img src="https://example.com/track">\n\n![tracking](https://example.com/track)\n\n[bad](javascript:alert%281%29)\n\n[docs](https://example.com/docs)\n\n```sh\ncat /etc/hosts\n```',
    }));
    expect(markup).not.toMatch(/<script|<img|javascript:|<h1/);
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain("cat /etc/hosts");
    expect(markup).toContain("<pre");
  });

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
