import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ScenarioSourceSection,
  scenarioSourceCardVisible,
} from "@/components/app/pages/organization-detail/scenario-source";
import type { ScenarioSourceView } from "@/lib/scenario-sources";
import { formatScenarioResourceItems } from "./ScenarioRegistry";

function renderCard(source: Partial<ScenarioSourceView> | null): string {
  const endpoint = "/api/admin/scenario-source";
  const queryClient = new QueryClient();
  queryClient.setQueryData(["scenario-source", endpoint], {
    enabled: true,
    appSlug: null,
    source: source && {
      repository: "intar-dev/scenarios",
      defaultBranch: "main",
      mode: "pull",
      pausedAt: null,
      pauseReason: null,
      disconnectedAt: null,
      liveSha: null,
      liveAt: null,
      commit: null,
      builds: [],
      ...source,
    },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ScenarioSourceSection, { endpoint, scope: "public" }),
    ),
  );
}

describe("scenario source card", () => {
  const source = { repository: "intar-dev/scenarios" } as ScenarioSourceView;

  it("hides the public card until a repository is pinned or bound", () => {
    const card = { enabled: true, configured: false, appSlug: null };
    expect(scenarioSourceCardVisible({ ...card, source: null })).toBe(false);
    expect(
      scenarioSourceCardVisible({ ...card, configured: true, source: null }),
    ).toBe(true);
    expect(scenarioSourceCardVisible({ ...card, source })).toBe(true);
  });

  it("shows an organization card once the flag is on or a binding exists", () => {
    const card = { enabled: false, appSlug: null };
    expect(scenarioSourceCardVisible({ ...card, source: null })).toBe(false);
    expect(
      scenarioSourceCardVisible({ ...card, enabled: true, source: null }),
    ).toBe(true);
    expect(scenarioSourceCardVisible({ ...card, source })).toBe(true);
  });

  it("asks for a first commit before connecting", () => {
    expect(renderCard(null)).toContain(
      "Push at least one commit to the repository&#x27;s default branch.",
    );
  });

  it("offers an admin pause over a suspension, but only resume otherwise", () => {
    const suspended = renderCard({ pausedAt: 1, pauseReason: "suspended" });
    expect(suspended).toContain("Pause</button>");
    expect(suspended).toContain("Resume</button>");
    const lost = renderCard({ pausedAt: 1, pauseReason: "binder_lost_admin" });
    expect(lost).not.toContain("Pause</button>");
    expect(lost).toContain("Resume</button>");
    const active = renderCard({});
    expect(active).toContain("Pause</button>");
    expect(active).not.toContain("Resume</button>");
  });
});

describe("scenario registry resources", () => {
  it("formats aggregate CPU, RAM, and disk requirements", () => {
    expect(
      formatScenarioResourceItems({
        cpuMillis: 2_000,
        memoryMib: 2_048,
        diskMib: 16_384,
      }),
    ).toEqual(["2 CPU", "2 GiB RAM", "16 GiB disk"]);
  });
});
