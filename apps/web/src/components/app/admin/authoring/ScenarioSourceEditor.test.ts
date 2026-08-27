import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScenarioSourceEditor } from "./ScenarioSourceEditor";

describe("ScenarioSourceEditor", () => {
  it("uses a native controlled textarea with form and validation attributes", () => {
    const initial = renderToStaticMarkup(
      createElement(ScenarioSourceEditor, {
        value: 'name = "demo"',
        onChange: () => undefined,
        name: "source",
        required: true,
        readOnly: true,
        disabled: true,
        "aria-invalid": "true",
      }),
    );
    const updated = renderToStaticMarkup(
      createElement(ScenarioSourceEditor, {
        value: 'name = "changed"',
        onChange: () => undefined,
      }),
    );

    expect(initial).toContain("<textarea");
    expect(initial).toContain('name="source"');
    expect(initial).toContain('aria-label="Scenario HCL source"');
    expect(initial).toContain('aria-invalid="true"');
    expect(initial).toContain('spellCheck="false"');
    expect(initial).toContain('wrap="off"');
    expect(initial).toContain("readOnly");
    expect(initial).toContain("disabled");
    expect(initial).toContain('name = &quot;demo&quot;');
    expect(updated).toContain('name = &quot;changed&quot;');
    expect(updated).not.toContain('name = &quot;demo&quot;');
    expect(initial).not.toContain("cm-");
  });
});
