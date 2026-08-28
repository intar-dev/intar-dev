import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseDescription } from "./CourseDescription";

const description =
  "Credit: [Rawkode Academy](https://rawkode.academy). Repair the cluster.";

describe("CourseDescription", () => {
  it("renders authored links on course detail pages", () => {
    const markup = renderToStaticMarkup(
      createElement(CourseDescription, { children: description }),
    );

    expect(markup).toContain('href="https://rawkode.academy"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain("Rawkode Academy");
  });

  it("uses link labels without nested anchors in course pickers", () => {
    const markup = renderToStaticMarkup(
      createElement(CourseDescription, {
        children: description,
        links: false,
      }),
    );

    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("https://rawkode.academy");
    expect(markup).toContain("Credit: Rawkode Academy. Repair the cluster.");
  });
});
