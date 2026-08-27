import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getRunSavingAnnouncement,
  getRunSavingStage,
  getRunSavingStepState,
  ReplayViewer,
  RunRecap,
  RUN_SAVING_STALLED_DELAY_MS,
  RUN_SAVING_STEPS,
} from "./RunRecap";
import {
  getRunRecapObjectives,
  getRunRecapState,
  getRunReplayAvailability,
  getRunReplayParts,
} from "./run-recap-model";
import type {
  ScenarioProbeStatus,
  ScenarioRunRecord,
  ScenarioRunVmRecord,
  SessionTimelineEntry,
} from "./run-types";

describe("run recap model", () => {
  it("uses learner outcomes instead of lifecycle state", () => {
    expect(getRunRecapState(run({ activity: "background" }))).toMatchObject({
      kind: "saving",
      title: "Saving your run…",
    });
    expect(getRunRecapState(run({ outcome: "succeeded", solvedAt: 2 }))).toMatchObject({
      kind: "solved",
      title: "Solved",
    });
    expect(getRunRecapState(run({ outcome: "cancelled" }))).toMatchObject({
      kind: "ended_early",
      title: "Ended early",
    });
    expect(getRunRecapState(run({ outcome: "failed", phase: "failed" }))).toMatchObject({
      kind: "could_not_finish",
      title: "Could not finish",
    });
  });

  it("maps only learner-safe save stages and keeps legacy runs coarse", () => {
    for (const [index, stage] of RUN_SAVING_STEPS.entries()) {
      expect(
        getRunSavingStage(
          run({ activity: "background", savingStage: stage.stage }),
        ),
      ).toBe(stage.stage);
      expect(
        RUN_SAVING_STEPS.map((candidate) =>
          getRunSavingStepState(stage.stage, candidate.stage),
        ),
      ).toEqual(
        RUN_SAVING_STEPS.map((_, candidateIndex) =>
          candidateIndex < index
            ? "done"
            : candidateIndex === index
              ? "active"
              : "up_next",
        ),
      );
    }

    expect(
      getRunSavingStage(
        run({ activity: "background", phase: "archiving", savingStage: null }),
      ),
    ).toBe("closing_workspace");

    expect(getRunSavingAnnouncement("future_stage")).toBe(
      "Stage 1 of 5: Save requested. In progress.",
    );
    expect(
      RUN_SAVING_STEPS.map((candidate) =>
        getRunSavingStepState("future_stage", candidate.stage),
      ),
    ).toEqual(["active", "up_next", "up_next", "up_next", "up_next"]);
  });

  it("maps only authored objective copy to final results", () => {
    const unsafe = run({
      objectives: [
        {
          probeName: "internal-nginx-probe",
          vmName: "web",
          label: "raw objective label",
          title: "Restore the default site",
          bodyMarkdown: "raw objective body",
          hintCount: 8,
        },
      ],
      vms: [
        vm({
          scenarioProbes: [
            probe({
              id: "internal-nginx-probe",
              label: "raw probe label",
              kind: "command_json_path",
              status: "pass",
              error: "raw probe error",
              value: { stdout: "raw probe value" },
            }),
          ],
        }),
      ],
    });

    const objectives = getRunRecapObjectives(unsafe);

    expect(objectives).toEqual([
      {
        key: "objective-1",
        title: "Restore the default site",
        status: "verified",
      },
    ]);
    expect(JSON.stringify(objectives)).not.toContain("raw");
    expect(JSON.stringify(objectives)).not.toContain("internal-nginx-probe");
  });

  it("models pending, unavailable, and ready replays without replay metadata", () => {
    const pending = run({ replayState: "preparing", activity: "background" });
    const unavailable = run({ replayState: "failed" });
    const ready = run({
      replayState: "ready",
      hasReplay: true,
      vms: [
        vm({
          id: "web-vm",
          scenarioVmName: "web",
          sessions: [session({ castArtifactId: "cast-web" })],
        }),
        vm({
          id: "database-vm",
          scenarioVmName: "database",
          sessions: [session({ castArtifactId: null })],
        }),
      ],
    });

    expect(getRunReplayAvailability(pending)).toBe("pending");
    expect(getRunReplayAvailability(unavailable)).toBe("unavailable");
    expect(getRunReplayAvailability(ready)).toBe("ready");
    expect(getRunReplayParts(ready)).toEqual([
      {
        key: "replay-cast-web",
        machineLabel: "web",
        partLabel: "Part 1",
        castArtifactId: "cast-web",
      },
    ]);
  });

  it("orders replay parts by machine ordinal and session index", () => {
    const unordered = run({
      replayState: "ready",
      hasReplay: true,
      vms: [
        vm({
          id: "worker-vm",
          ordinal: 2,
          scenarioVmName: "worker",
          sessions: [session({ index: 1, castArtifactId: "cast-worker-1" })],
        }),
        vm({
          id: "web-vm",
          ordinal: 1,
          scenarioVmName: "web",
          sessions: [
            session({ index: 2, castArtifactId: "cast-web-2" }),
            session({ index: 3, castArtifactId: null }),
            session({ index: 1, castArtifactId: "cast-web-1" }),
          ],
        }),
      ],
    });
    const sourceVms = structuredClone(unordered.vms);

    const orderedParts = getRunReplayParts(unordered);
    expect(
      orderedParts.map(
        ({ machineLabel, partLabel, castArtifactId }) => ({
          machineLabel,
          partLabel,
          castArtifactId,
        }),
      ),
    ).toEqual([
      {
        machineLabel: "web",
        partLabel: "Part 1",
        castArtifactId: "cast-web-1",
      },
      {
        machineLabel: "web",
        partLabel: "Part 2",
        castArtifactId: "cast-web-2",
      },
      {
        machineLabel: "worker",
        partLabel: "Part 3",
        castArtifactId: "cast-worker-1",
      },
    ]);
    expect(unordered.vms).toEqual(sourceVms);

    const reorderedSource = structuredClone(unordered);
    reorderedSource.vms.reverse();
    for (const machine of reorderedSource.vms) {
      machine.sessionTimeline?.reverse();
    }
    expect(getRunReplayParts(reorderedSource)).toEqual(orderedParts);
  });
});

describe("RunRecap", () => {
  it("renders a learner-only solved recap", () => {
    const markup = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({
          outcome: "succeeded",
          solvedAt: 31_000,
          solveDurationMs: 30_000,
          replayState: "none",
          objectives: [
            {
              probeName: "hidden-probe-id",
              vmName: "web",
              label: "hidden objective label",
              title: "Restore the default site",
              bodyMarkdown: "hidden objective detail",
              hintCount: 99,
            },
          ],
          hints: [
            {
              key: "hint-1",
              scope: "scenario",
              probeName: null,
              id: "hidden-hint-id",
              title: "hidden hint title",
              revealed: true,
              unlocked: true,
              bodyMarkdown: "hidden hint body",
            },
          ],
          solution: {
            unlocked: true,
            revealed: true,
            assisted: true,
            revealedAt: 20_000,
            bodyMarkdown: "hidden solution body",
          },
          vms: [
            vm({
              hostname: "hidden-hostname",
              scenarioProbes: [
                probe({
                  id: "hidden-probe-id",
                  label: "hidden probe label",
                  kind: "command_json_path",
                  status: "pass",
                  error: "hidden raw probe error",
                  value: { stdout: "hidden raw probe value" },
                }),
              ],
            }),
          ],
        }),
        nextAction: createElement("button", { type: "button" }, "Continue"),
      }),
    );

    expect(markup).toContain("Solved");
    expect(markup).toContain("Final checks");
    expect(markup).toContain("Restore the default site");
    expect(markup).toContain("Verified");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Final checks progress"');
    expect(markup).toContain('aria-valuenow="1"');
    expect(markup).toContain('aria-valuemax="1"');
    expect(markup).toContain('aria-valuetext="1 of 1 final checks verified"');
    expect(markup).toContain('data-status="verified"');
    expect(markup).toContain("00:30");
    expect(markup).toContain("1 hint");
    expect(markup).toContain("Full solution");
    expect(markup).toContain("Continue");
    expect(markup).not.toContain("Watch replay");
    for (const forbidden of [
      "hidden-probe-id",
      "hidden objective label",
      "hidden objective detail",
      "hidden probe label",
      "command_json_path",
      "hidden raw probe error",
      "hidden raw probe value",
      "hidden-hostname",
      "hidden-hint-id",
      "hidden hint title",
      "hidden solution body",
      "SHA-256",
      "SSH target",
      "Transcript",
      "Command log",
      "Run timeline",
    ]) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it("shows partial objective progress without technical data", () => {
    const markup = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({
          objectives: [
            objective("service-running", "Start the web server"),
            objective("site-reachable", "Make the site reachable"),
            objective("default-site", "Restore the default site"),
          ],
          vms: [
            vm({
              scenarioProbes: [
                probe({ id: "service-running", status: "pass" }),
                probe({ id: "site-reachable", status: "fail" }),
                probe({ id: "default-site", status: "pass" }),
              ],
            }),
          ],
        }),
        nextAction: createElement("button", { type: "button" }, "Try again"),
      }),
    );

    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuemax="3"');
    expect(markup).toContain('aria-valuetext="2 of 3 final checks verified"');
    expect(markup.match(/data-status="verified"/g)).toHaveLength(2);
    expect(markup.match(/data-status="needs_repair"/g)).toHaveLength(1);
    expect(markup).not.toContain("hidden raw error");
    expect(markup).not.toContain("command_json_path");
  });

  it("omits objective progress when the recap has no checks", () => {
    const markup = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({
          objectives: [],
          vms: [vm({ scenarioProbes: [] })],
        }),
        nextAction: createElement("button", { type: "button" }, "Continue"),
      }),
    );

    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("Final checks");
  });

  it("shows a five-step saving state without internal teardown data", () => {
    const markup = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({
          activity: "background",
          phase: "archiving",
          phaseTitle: "Archiving",
          phaseDetail: "hidden cleanup state",
          progressPercent: 47,
          savingStage: "saving_files",
          replayState: "preparing",
        }),
      }),
    );

    expect(markup).toContain("Saving your run…");
    expect(markup).toContain("Your recap will be ready in a moment.");
    expect(markup).toContain("Stage 3 of 5");
    expect(markup).not.toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="Saving steps"');
    expect(markup).toContain("Save requested");
    expect(markup).toContain("Closing workspace");
    expect(markup).toContain("Saving files");
    expect(markup).toContain("Preparing replay");
    expect(markup).toContain("Finalizing recap");
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('data-run-sequence-screen="true"');
    expect(markup.match(/data-run-sequence-step="true"/g)).toHaveLength(5);
    expect(markup.match(/data-state="done"/g)).toHaveLength(2);
    expect(markup.match(/data-state="active"/g)).toHaveLength(1);
    expect(markup.match(/data-state="pending"/g)).toHaveLength(2);
    expect(markup).not.toContain('role="progressbar"');
    expect(RUN_SAVING_STALLED_DELAY_MS).toBe(30_000);
    expect(markup).not.toContain("Archiving");
    expect(markup).not.toContain("hidden cleanup state");
    expect(markup).not.toContain("47%");
    expect(markup).not.toContain("Watch replay");
  });

  it("keeps replay to one learner-facing section and only uses authored machine labels", () => {
    const markup = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({
          replayState: "ready",
          hasReplay: true,
          vms: [
            vm({
              id: "web-vm",
              scenarioVmName: "web",
              runtimeVmName: "hidden-runtime-web",
              hostname: "hidden-host-web",
              sessions: [
                session({
                  castArtifactId: "cast-web",
                  castFilename: "hidden-web.cast",
                }),
              ],
            }),
            vm({
              id: "db-vm",
              scenarioVmName: "database",
              runtimeVmName: "hidden-runtime-db",
              hostname: "hidden-host-db",
              sessions: [
                session({
                  castArtifactId: null,
                  castFilename: "hidden-db.cast",
                }),
              ],
            }),
          ],
        }),
        nextAction: createElement("button", { type: "button" }, "Continue"),
      }),
    );

    expect(markup.match(/Watch replay/g)).toHaveLength(1);
    for (const forbidden of [
      "hidden-runtime-web",
      "hidden-runtime-db",
      "hidden-host-web",
      "hidden-host-db",
      "hidden-web.cast",
      "hidden-db.cast",
      "Transcript",
      "Command log",
      "Exit status",
    ]) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it("uses a carousel only when several ordered replay parts exist", () => {
    const multiParts = getRunReplayParts(
      run({
        replayState: "ready",
        hasReplay: true,
        vms: [
          vm({
            sessions: [
              session({ index: 2, castArtifactId: "cast-2" }),
              session({ index: 1, castArtifactId: "cast-1" }),
            ],
          }),
        ],
      }),
    );
    const multiPart = renderToStaticMarkup(
      createElement(ReplayViewer, {
        runId: "safe-run",
        parts: multiParts,
      }),
    );
    const singlePart = renderToStaticMarkup(
      createElement(ReplayViewer, {
        runId: "safe-run",
        parts: [
          {
            key: "part-1",
            machineLabel: null,
            partLabel: "Part 1",
            castArtifactId: "cast-only",
          },
        ],
      }),
    );

    expect(multiPart).toContain("data-run-replay-carousel");
    expect(multiPart).toContain('aria-roledescription="carousel"');
    expect(multiPart).toContain("Part 1 of 2");
    expect(multiPart).toContain('aria-label="Previous replay part"');
    expect(multiPart).toContain('aria-label="Next replay part"');
    expect(multiPart.indexOf("Show Part 1 of 2")).toBeLessThan(
      multiPart.indexOf("Show Part 2 of 2"),
    );
    expect(singlePart).not.toContain("data-run-replay-carousel");
    expect(singlePart).not.toContain("Previous replay part");
    expect(singlePart).not.toContain("Next replay part");
  });

  it("offers a download instead of loading an oversized replay", () => {
    const markup = renderToStaticMarkup(
      createElement(ReplayViewer, {
        runId: "safe-run",
        parts: [
          {
            key: "part-large",
            machineLabel: null,
            partLabel: "Part 1",
            castArtifactId: "cast-large",
            sizeBytes: 3 * 1024 * 1024,
          },
        ],
      }),
    );

    expect(markup).toContain("too large to play in the page");
    expect(markup).toContain("Download replay");
    expect(markup).not.toContain("run-artifact-player");
  });

  it("names pending and unavailable replay states without a technical explanation", () => {
    const pending = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({ replayState: "preparing" }),
        nextAction: createElement("button", { type: "button" }, "Continue"),
      }),
    );
    const unavailable = renderToStaticMarkup(
      createElement(RunRecap, {
        run: run({ replayState: "failed" }),
        nextAction: createElement("button", { type: "button" }, "Continue"),
      }),
    );

    expect(pending).toContain("Your replay is being prepared.");
    expect(unavailable).toContain("Replay unavailable.");
    expect(pending).not.toContain("upload");
    expect(unavailable).not.toContain("session metadata");
  });
});

function run(overrides: Partial<ScenarioRunRecord> = {}): ScenarioRunRecord {
  const vms = overrides.vms ?? [vm()];
  return {
    id: "run-1",
    scenarioId: "broken-nginx",
    organizationId: null,
    scenarioName: "Broken Nginx",
    phase: "completed",
    phaseTitle: "Completed",
    phaseDetail: "Saved run state.",
    title: "Repair Broken Nginx",
    tagline: "Restore a site.",
    briefingMarkdown: "Fix the site.",
    objectives: [
      {
        probeName: "site-ready",
        vmName: "web",
        label: "Site ready",
        title: "Restore the site",
        bodyMarkdown: null,
        hintCount: 0,
      },
    ],
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
    outcome: "cancelled",
    active: false,
    activity: "settled",
    deleteRequestedAt: null,
    savingStage: null,
    replayState: "none",
    hasReplay: false,
    progressPercent: 100,
    terminalPhase: "ready",
    canOpenTerminal: false,
    canDestroy: false,
    createdAt: 1,
    updatedAt: 2,
    bootProbes: [],
    scenarioProbes: vms.flatMap((machine) => machine.scenarioProbes),
    replayArtifacts: [],
    vms,
    ...overrides,
  };
}

function objective(probeName: string, title: string) {
  return {
    probeName,
    vmName: "web",
    label: "hidden objective label",
    title,
    bodyMarkdown: "hidden objective detail",
    hintCount: 0,
  };
}

function vm(
  overrides: Partial<ScenarioRunVmRecord> & {
    sessions?: SessionTimelineEntry[] | null;
  } = {},
): ScenarioRunVmRecord {
  const { sessions, ...rest } = overrides;
  return {
    id: "vm-1",
    ordinal: 0,
    scenarioVmId: "web",
    scenarioVmName: "web",
    runtimeVmName: "hidden-runtime-name",
    hostname: "hidden-hostname",
    phase: "completed",
    phaseTitle: "Completed",
    phaseDetail: "Hidden VM detail.",
    progressPercent: 100,
    terminalPhase: "ready",
    canOpenTerminal: false,
    bootProbes: [],
    scenarioProbes: [probe()],
    replayArtifacts: [],
    sessionTimeline: sessions ?? null,
    provisioning: {
      image: "hidden-image",
      imageKey: null,
      imageSha256: "hidden-sha256",
      resources: null,
      leaseDurationSeconds: null,
      groupName: null,
      groupId: null,
      setupKeyId: null,
      status: "pending",
      error: null,
    },
    terminalTarget: {
      host: "hidden-ssh-target",
      port: 22,
      username: "root",
      hostKeyOpenssh: "hidden-host-key",
      checkedAt: null,
    },
    ...rest,
  };
}

function probe(
  overrides: Partial<ScenarioProbeStatus> = {},
): ScenarioProbeStatus {
  return {
    id: "site-ready",
    label: "hidden probe label",
    kind: "command_json_path",
    phase: "scenario",
    status: "fail",
    error: "hidden raw error",
    value: { stdout: "hidden raw value" },
    ...overrides,
  };
}

function session(
  overrides: Partial<SessionTimelineEntry> = {},
): SessionTimelineEntry {
  return {
    index: 1,
    startTimestampMs: 1_000,
    durationMs: 5_000,
    exitCode: 0,
    castFilename: "hidden.cast",
    castArtifactId: "cast-1",
    transcriptTruncated: false,
    ...overrides,
  };
}
