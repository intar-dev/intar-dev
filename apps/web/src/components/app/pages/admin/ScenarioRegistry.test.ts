import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ScenarioSourceSection,
  scenarioSourceCardVisible,
} from "@/components/app/pages/organization-detail/scenario-source";
import type { ScenarioSourceCard, ScenarioSourceView } from "@/lib/scenario-sources";
import { formatScenarioResourceItems } from "./ScenarioRegistry";

function renderCard(
  source: Partial<ScenarioSourceView> | null,
  pipelineWorkflowRef: string | null = null,
  card: Partial<ScenarioSourceCard> = {},
): string {
  const endpoint = "/api/admin/scenario-source";
  const queryClient = new QueryClient();
  queryClient.setQueryData(["scenario-source", endpoint], {
    enabled: true,
    appSlug: null,
    pipelineImages: false,
    workflowRef: "scenario-publish-v1",
    pipelineWorkflowRef,
    ...card,
    source: source && {
      repository: "intar-dev/scenarios",
      defaultBranch: "main",
      mode: "push",
      imageProducer: "builder",
      allowSelfHostedRunners: false,
      promotion: "manual",
      pausedAt: null,
      pauseReason: null,
      disconnectedAt: null,
      disconnectReason: null,
      liveSha: null,
      liveAt: null,
      commit: null,
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
    const card = { enabled: true, pipelineImages: false, configured: false, appSlug: null, workflowRef: "scenario-publish-v1", pipelineWorkflowRef: null };
    expect(scenarioSourceCardVisible({ ...card, source: null })).toBe(false);
    expect(
      scenarioSourceCardVisible({ ...card, configured: true, source: null }),
    ).toBe(true);
    expect(scenarioSourceCardVisible({ ...card, source })).toBe(true);
  });

  it("shows an organization card once the flag is on or a binding exists", () => {
    const card = { enabled: false, pipelineImages: false, appSlug: null, workflowRef: "scenario-publish-v1", pipelineWorkflowRef: null };
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

  it("ends the connect steps with the workflow file, whose push is the first publish", () => {
    expect(renderCard(null)).toContain("that push is the first publish");
  });

  it("links to the builds page only while the builder builds the source's images", () => {
    expect(renderCard(null)).not.toContain('href="/admin/builds"');
    expect(renderCard({})).toContain('href="/admin/builds"');
    expect(renderCard({ disconnectedAt: 1, disconnectReason: "admin" })).toContain('href="/admin/builds"');
    expect(renderCard({ imageProducer: "pipeline" })).not.toContain('href="/admin/builds"');
  });

  it("offers no choice of delivery mode, and a pull source its way to push", () => {
    const push = renderCard({});
    expect(push).not.toContain("Delivery mode");
    expect(push).not.toContain("Switch to push");
    expect(push).not.toContain("Pull mode");
    expect(push).toContain("a push to the default branch publishes");
    const pull = renderCard({ mode: "pull" });
    expect(pull).not.toContain("Delivery mode");
    expect(pull).toContain("Switch to push</button>");
    expect(pull).toContain("switch to push first, then commit the workflow file");
    expect(pull).toContain("keep only");
  });

  it("says who builds a source's images and who puts its labs live", () => {
    const builder = renderCard({});
    expect(builder).toContain("Built by Intar&#x27;s builder");
    expect(builder).toContain("An administrator promotes each lab");
    const pipeline = renderCard({ imageProducer: "pipeline", promotion: "automatic" });
    expect(pipeline).toContain("Built by this repository&#x27;s pipeline");
    expect(pipeline).toContain("Each lab goes live once it passed its check");
  });

  it("shows the workflow ref the server names, and a pipeline source the second version with its runner", () => {
    const builder = renderCard({});
    expect(builder).toContain("scenario-publish.yml@scenario-publish-v1");
    expect(builder).not.toContain("runner:");
    expect(renderCard(null)).toContain("scenario-publish.yml@scenario-publish-v1");
    // No released second version yet: no snippet that would build nothing.
    const untagged = renderCard({ imageProducer: "pipeline" });
    expect(untagged).not.toContain("scenario-publish.yml@");
    expect(untagged).toContain("call it at the commit");
    const pipeline = renderCard({ imageProducer: "pipeline" }, "scenario-publish-v2");
    expect(pipeline).toContain("scenario-publish.yml@scenario-publish-v2");
    expect(pipeline).toContain("runner: your-kvm-runner");
    expect(pipeline).toContain("accepts GitHub-hosted runners only");
    expect(renderCard({ imageProducer: "pipeline", allowSelfHostedRunners: true }, "scenario-publish-v2"))
      .toContain("accepts a self-hosted runner");
  });

  describe("platform settings", () => {
    const platform = (source: Partial<ScenarioSourceView>, card: Partial<ScenarioSourceCard> = {}) =>
      renderCard(source, null, { platformSettings: { automaticPromotion: false }, ...card });
    /** The button with this label, as rendered: disabled or not. */
    const button = (html: string, label: string) => {
      const end = html.indexOf(`${label}</button>`);
      expect(end, label).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf("<button", end), end);
    };

    it("are on the platform's card only, and only for a connected source", () => {
      expect(renderCard({})).not.toContain("Platform settings");
      expect(platform({})).toContain("Platform settings");
      expect(renderCard(null, null, { platformSettings: { automaticPromotion: true } })).not.toContain("Platform settings");
      expect(platform({ disconnectedAt: 1, disconnectReason: "admin" })).not.toContain("Platform settings");
    });

    it("offer the other state of each setting", () => {
      const builder = platform({}, { pipelineImages: true, platformSettings: { automaticPromotion: true } });
      for (const label of ["Use the repository's pipeline", "Allow self-hosted runners", "Go live automatically", "Switch to pull"]) {
        expect(button(builder, label.replace("'", "&#x27;"))).not.toMatch(/ disabled(=""|>| )/);
      }
      const pipeline = platform({ imageProducer: "pipeline", allowSelfHostedRunners: true, promotion: "automatic" });
      for (const label of ["Use Intar&#x27;s builder", "GitHub-hosted only", "Promote by hand"]) {
        expect(button(pipeline, label)).not.toMatch(/ disabled(=""|>| )/);
      }
    });

    it("say why a switch is not offered: a flag that is off, a pull source, a pipeline before pull", () => {
      const off = platform({});
      expect(button(off, "Use the repository&#x27;s pipeline")).toMatch(/ disabled(=""|>| )/);
      expect(off).toContain("Pipeline images are not switched on for this scope.");
      expect(button(off, "Go live automatically")).toMatch(/ disabled(=""|>| )/);
      expect(off).toContain("Automatic promotion is not switched on for this scope.");
      const pull = platform({ mode: "pull" }, { pipelineImages: true });
      expect(button(pull, "Use the repository&#x27;s pipeline")).toMatch(/ disabled(=""|>| )/);
      expect(pull).toContain("A pipeline builds only for a source in push mode.");
      expect(pull).not.toContain("Switch to pull");
      const pipeline = platform({ imageProducer: "pipeline" });
      expect(button(pipeline, "Switch to pull")).toMatch(/ disabled(=""|>| )/);
      expect(pipeline).toContain("Set the images back to Intar&#x27;s builder first.");
      // The way back never needs a flag.
      const back = platform({ imageProducer: "pipeline", allowSelfHostedRunners: true, promotion: "automatic" }, { enabled: false });
      for (const label of ["Use Intar&#x27;s builder", "GitHub-hosted only", "Promote by hand"]) {
        expect(button(back, label)).not.toMatch(/ disabled(=""|>| )/);
      }
    });
  });

  it("says a push source without a commit waits for its first workflow run", () => {
    expect(renderCard({})).toContain("Waiting for the first workflow run");
    expect(renderCard({ mode: "pull" })).not.toContain("Waiting for the first workflow run");
  });

  it("offers to delete what a disconnected repository published", () => {
    expect(renderCard({})).not.toContain("Delete courses and scenarios");
    const disconnected = renderCard({ disconnectedAt: 1, disconnectReason: "admin" });
    expect(disconnected).toContain("Delete courses and scenarios</button>");
    expect(disconnected).toContain("Connect repository");
    expect(
      renderCard({ disconnectedAt: 1, disconnectReason: "purging" }),
    ).toContain("Finish deleting</button>");
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
