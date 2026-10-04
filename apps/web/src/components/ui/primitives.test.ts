import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert } from "./alert";
import { ArrowRight } from "lucide-react";
import { AvatarFallback } from "./avatar";
import { Button } from "./button";
import { Input } from "./input";
import { Skeleton } from "./skeleton";
import { Table, TableRowHeader } from "./table";
import { Textarea } from "./textarea";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);

describe("Alert", () => {
  it("is polite unless it answers an action", () => {
    expect(html(createElement(Alert, null, "x"))).toContain('role="status"');
    expect(html(createElement(Alert, { variant: "destructive" }, "x"))).toContain(
      'role="status"',
    );
    const just = html(createElement(Alert, { variant: "destructive", just: true }, "x"));
    expect(just).toContain('role="alert"');
    expect(just).toContain("animate-rise");
    expect(html(createElement(Alert, { just: true }, "x"))).toContain('role="status"');
  });

  it("leads with an icon unless told otherwise", () => {
    expect(html(createElement(Alert, null, "x"))).toContain("<svg");
    expect(html(createElement(Alert, { icon: null }, "x"))).not.toContain("<svg");
  });
});

describe("Button", () => {
  it("keeps link semantics when rendered as an anchor", () => {
    const out = html(
      createElement(Button, { render: createElement("a", { href: "/x" }) }, "Go"),
    );
    expect(out).toContain("<a");
    expect(out).not.toContain('role="button"');
    expect(out).toContain('data-slot="button"');
  });
});

describe("Button icon sides", () => {
  it("trims the icon side, also when the children sit in a Fragment", () => {
    const direct = html(
      createElement(Button, null, "Resume", createElement(ArrowRight)),
    );
    const wrapped = html(
      createElement(
        Button,
        null,
        createElement(Fragment, null, "Resume", createElement(ArrowRight)),
      ),
    );
    expect(direct).toContain('data-icon-end="true"');
    expect(wrapped).toContain('data-icon-end="true"');
    expect(wrapped).not.toContain('data-icon-start="true"');
    expect(html(createElement(Button, null, "Resume"))).not.toContain(
      'data-icon-end="true"',
    );
  });
});

describe("Avatar fallback", () => {
  it("is decorative", () => {
    expect(html(createElement(AvatarFallback, null, "AL"))).toContain('aria-hidden="true"');
  });
});

describe("Skeleton", () => {
  it("is hidden from assistive technology", () => {
    expect(html(createElement(Skeleton))).toContain('aria-hidden="true"');
  });
});

describe("Table", () => {
  it("names a focusable scroll region only when labelled", () => {
    const labelled = html(createElement(Table, { label: "Orgs" }));
    expect(labelled).toContain('role="region"');
    expect(labelled).toContain('aria-label="Orgs"');
    expect(labelled).toContain('tabindex="0"');
    expect(html(createElement(Table))).not.toContain("tabindex");
  });

  it("has a row header", () => {
    expect(html(createElement(TableRowHeader, null, "Ada"))).toContain('scope="row"');
  });
});

describe("Input", () => {
  it("stops at the field width unless a caller lets it stretch", () => {
    expect(html(createElement(Input))).toContain("max-w-(--field-max)");
    // A search or filter input passes max-w-none, which wins the merge.
    const search = html(createElement(Input, { className: "max-w-none" }));
    expect(search).toContain("max-w-none");
    expect(search).not.toContain("max-w-(--field-max)");
  });
});

describe("Textarea", () => {
  it("mono turns spellcheck and autofill off", () => {
    const out = html(createElement(Textarea, { mono: true }));
    expect(out).toContain('spellCheck="false"');
    expect(out).toContain('autoComplete="off"');
  });
});
