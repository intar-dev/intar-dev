import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RosterEditor } from "./OrganizationWorkshops";

describe("workshop roster editor", () => {
  it("keeps the organization manager as facilitator while opting into a learner workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(RosterEditor, {
        members: [
          {
            userId: "owner",
            name: "Workshop owner",
            email: "owner@example.test",
          },
        ],
        viewerUserId: "owner",
        roster: {
          owner: { role: "facilitator", workspaceEnabled: true },
        },
        workspaceCount: 1,
        onChange: () => {},
      }),
    );

    expect(markup).toContain(
      '<option value="facilitator" selected="">Facilitator</option>',
    );
    expect(markup).toMatch(/<select[^>]*\sdisabled=/);
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*>/);
    expect(markup).toContain("1 learner workspace");
    expect(markup).toContain('<option value="excluded" disabled="">');
  });

  it("makes a participant workspace mandatory", () => {
    const markup = renderToStaticMarkup(
      createElement(RosterEditor, {
        members: [
          {
            userId: "learner",
            name: "Workshop learner",
            email: "learner@example.test",
          },
        ],
        viewerUserId: "owner",
        roster: {
          learner: { role: "participant", workspaceEnabled: false },
        },
        workspaceCount: 1,
        onChange: () => {},
      }),
    );

    const checkbox = markup.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toContain('checked=""');
    expect(checkbox).toContain('disabled=""');
  });
});
