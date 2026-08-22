import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProviderConnectionCard,
  RosterEditor,
} from "./OrganizationWorkshops";

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

describe("provider connection health", () => {
  it("shows a failed active check as unhealthy", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderConnectionCard, {
        organizationId: "org-a",
        role: "admin",
        connection: {
          id: "provider-gcp-a",
          providerKind: "gcp_compute",
          displayName: "GCP Compute",
          state: "rotation_required",
          externalProjectId: "intar-pilot-123",
          guardrails: {
            locations: ["europe-west3-a"],
            maxConcurrentAllocations: 5,
            maxSessionCostNanos: null,
          },
          providerDetails: {
            providerKind: "gcp_compute",
            projectNumber: "1234567890",
            networkName: "intar-network",
            subnetName: "intar-subnet",
            firewallName: "intar-firewall",
            nativeCurrency: "USD",
          },
          credential: {
            version: 1,
            authority: "active",
            fingerprint: "aaaa…bbbb",
            activatedAt: 100,
          },
          lastValidatedAt: 200,
          createdAt: 100,
          updatedAt: 200,
          cleanupAcknowledgement: null,
        },
        onChanged: async () => {},
      }),
    );

    expect(markup).toContain("rotation required");
    expect(markup).toContain("check failed");
    expect(markup).toContain("Connection check failed");
    expect(markup).toContain("New learner VMs are blocked");
    expect(markup).not.toContain(">active<");
  });
});
