import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ScenarioRunRecord,
  ScenarioRunVmRecord,
} from "@/components/app/run/run-types";

const pageState = vi.hoisted(() => ({
  run: null as ScenarioRunRecord | null,
  chrome: null as { action?: ReactNode; menu?: ReactNode } | null,
}));
const queryClient = vi.hoisted(() => ({
  cancelQueries: vi.fn(),
  getQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
}));
const mutation = vi.hoisted(() => ({
  error: null,
  isPending: false,
  mutate: vi.fn(),
  reset: vi.fn(),
  variables: null,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => mutation,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "scenarios" && queryKey[1] === "run" && queryKey[3] !== "status"
      ? { data: { run: pageState.run }, error: null }
      : { data: undefined, error: null },
  useQueryClient: () => queryClient,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ runId: "run-1" }),
  useSearch: () => ({}),
}));

vi.mock("@/components/app/shell/page-chrome", () => ({
  usePageChrome: (chrome: { action?: ReactNode; menu?: ReactNode }) => {
    pageState.chrome = chrome;
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/app/run/RunRecap", () => ({
  RunRecap: () => null,
}));

import { ScenarioRun } from "./ScenarioRun";

describe("scenario run terminal controls", () => {
  beforeEach(() => {
    pageState.run = null;
    pageState.chrome = null;
    vi.clearAllMocks();
  });

  it("keeps End run available only while a failed settled run needs teardown", () => {
    const pending = renderRun(run([vm("failed")]));

    expect(markup(pending?.action)).toContain("End run…");
    expect(markup(pending?.menu)).toContain("End run…");

    const complete = renderRun(run([vm("completed")]));

    expect(markup(complete?.action)).toContain("Delete run…");
    expect(markup(complete?.menu)).toContain("Delete run…");
    expect(markup(complete?.action)).not.toContain("End run…");
    expect(markup(complete?.menu)).not.toContain("End run…");
  });
});

function renderRun(
  run: ScenarioRunRecord,
): { action?: ReactNode; menu?: ReactNode } | null {
  pageState.run = run;
  pageState.chrome = null;
  renderToStaticMarkup(createElement(ScenarioRun));
  return pageState.chrome as { action?: ReactNode; menu?: ReactNode } | null;
}

function markup(node: ReactNode | undefined) {
  return node ? renderToStaticMarkup(createElement("div", null, node)) : "";
}

function run(vms: ScenarioRunVmRecord[]): ScenarioRunRecord {
  return {
    id: "run-1",
    scenarioId: "broken-nginx",
    organizationId: null,
    courseLocation: null,
    scenarioName: "Broken Nginx",
    phase: "failed",
    phaseTitle: "Could not finish",
    phaseDetail: "The workspace did not start.",
    title: "Repair Broken Nginx",
    tagline: "Restore the site.",
    briefingMarkdown: "Fix the site.",
    objectives: [],
    tags: [],
    hints: [],
    solution: {
      unlocked: false,
      revealed: false,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: null,
    },
    difficulty: "easy",
    estimatedMinutes: 15,
    solvedAt: null,
    solveDurationMs: null,
    outcome: "failed",
    active: false,
    activity: "settled",
    deleteRequestedAt: null,
    savingStage: null,
    replayState: "none",
    hasReplay: false,
    progressPercent: 0,
    terminalPhase: "failed",
    canOpenTerminal: false,
    canDestroy: false,
    createdAt: 1,
    updatedAt: 2,
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    vms,
  };
}

function vm(phase: ScenarioRunVmRecord["phase"]): ScenarioRunVmRecord {
  return {
    id: "vm-1",
    ordinal: 0,
    scenarioVmId: "web",
    scenarioVmName: "web",
    runtimeVmName: "runtime-web",
    hostname: "web",
    phase,
    phaseTitle: phase,
    phaseDetail: "Fixture machine state.",
    progressPercent: 0,
    terminalPhase: "failed",
    canOpenTerminal: false,
    terminalTarget: {
      host: null,
      port: 0,
      username: "root",
      hostKeyOpenssh: null,
      checkedAt: null,
    },
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    sessionTimeline: null,
    provisioning: {
      image: null,
      imageKey: null,
      imageSha256: null,
      resources: null,
      leaseDurationSeconds: null,
      groupName: null,
      groupId: null,
      setupKeyId: null,
      status: "pending",
      error: null,
    },
  };
}
