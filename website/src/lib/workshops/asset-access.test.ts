import { describe, expect, it } from "vitest";
import { workshopProjectionReferencesAsset } from "./asset-access";

describe("workshopProjectionReferencesAsset", () => {
  const input = {
    sessionId: "session/with spaces",
    assetPath: "assets/diagram-one.svg",
  };

  it("accepts an asset referenced by an authorized Markdown surface", () => {
    expect(
      workshopProjectionReferencesAsset(
        {
          session: {
            modules: [
              {
                contentMarkdown:
                  "![Diagram](/api/workshops/session%2Fwith%20spaces/assets/assets/diagram-one.svg)",
              },
            ],
          },
        },
        input,
      ),
    ).toBe(true);
  });

  it("rejects hidden, absent, or prefix-colliding asset references", () => {
    expect(
      workshopProjectionReferencesAsset(
        {
          session: {
            modules: [{ contentMarkdown: null }],
            slides: [
              {
                bodyMarkdown:
                  "![Other](/api/workshops/session%2Fwith%20spaces/assets/assets/diagram-one.svg.backup)",
              },
            ],
          },
        },
        input,
      ),
    ).toBe(false);
  });

  it("walks cyclic objects defensively", () => {
    const projection: Record<string, unknown> = {};
    projection.self = projection;
    expect(workshopProjectionReferencesAsset(projection, input)).toBe(false);
  });
});
