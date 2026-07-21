import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RosterEditor } from "./OrganizationWorkshops";

describe("workshop roster editor", () => {
  it("lets the organization manager select their own participant role", () => {
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
        roster: { owner: "participant" },
        participantCount: 1,
        onChange: () => {},
      }),
    );

    expect(markup).toContain(
      '<option value="participant" selected="">Participant</option>',
    );
    expect(markup).not.toMatch(/<select[^>]*\sdisabled=/);
    expect(markup).toContain('<option value="excluded" disabled="">');
  });
});
