import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseCredits } from "./CourseCredits";

describe("CourseCredits", () => {
  it("renders no row when credits are absent", () => {
    expect(renderToStaticMarkup(createElement(CourseCredits))).toBe("");
  });

  it("renders every credit as a safe external link", () => {
    const markup = renderToStaticMarkup(
      createElement(CourseCredits, {
        credits: [
          { label: "Rawkode Academy", url: "https://rawkode.academy" },
          {
            label: "David Flanagan",
            url: "https://rawkode.academy/people/rawkode",
          },
        ],
      }),
    );

    expect(markup).toContain("Credits:");
    expect(markup).toContain('href="https://rawkode.academy"');
    expect(markup).toContain(
      'href="https://rawkode.academy/people/rawkode"',
    );
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Rawkode Academy");
    expect(markup).toContain("David Flanagan");
  });
});
