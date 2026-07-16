import type { RunFixtureState } from "./shared";
import {
  FIXED_NOW,
  briefing,
  minute,
  objectives,
  runLifecycle,
  scenarioVm,
  sha,
} from "./shared";

export function makeRun(state: RunFixtureState): Record<string, unknown> {
  const lifecycle = runLifecycle(state);
  const complete = state === "archived" || state === "replay";
  const background = state === "ending";
  const solved = state === "solved" || complete;
  const ready = lifecycle.terminal === "ready";
  const bootProbe = {
    id: "boot-ready",
    label: "Machine ready",
    kind: "systemd_unit",
    phase: "boot",
    status: ready || complete || solved ? "pass" : "pending",
    error: state === "failed" ? "guest stopped during boot" : null,
    value: ready ? { state: "active", service: "sshd" } : null,
  };
  const repairProbe = {
    id: "nginx-listening",
    label: "nginx listens on port 80",
    kind: "tcp_connect",
    phase: "scenario",
    status: solved ? "pass" : "fail",
    error: solved ? null : "connection refused on 127.0.0.1:80",
    value: { host: "127.0.0.1", port: 80 },
  };
  const healthProbe = {
    id: "health-endpoint",
    label: "health endpoint returns ok",
    kind: "http_request",
    phase: "scenario",
    status: solved ? "pass" : "pending",
    error: null,
    value: solved ? { state: "healthy" } : null,
  };
  const terminalTarget = {
    host: ready ? "10.40.0.18" : null,
    port: ready ? 22 : 0,
    username: "root",
    hostKeyOpenssh: ready ? `ssh-ed25519 ${"A".repeat(68)}` : null,
    checkedAt: ready ? FIXED_NOW - minute : null,
  };
  const replayArtifacts =
    state === "replay"
      ? [
          {
            id: "artifact-cast-1",
            hostId: "host-eu-1",
            runId: "run-active",
            vmId: "run-vm-web",
            kind: "asciicast",
            filename: "session.cast",
            contentType: "application/x-asciicast",
            sizeBytes: 512,
          },
        ]
      : [];

  return {
    id: "run-active",
    scenarioId: "repair-nginx",
    scenarioName: "repair-nginx",
    title: briefing.title,
    tagline: briefing.tagline,
    briefingMarkdown: briefing.briefingMarkdown,
    objectives,
    tags: briefing.tags,
    hints: [
      {
        key: "scenario:hint-1",
        scope: "scenario",
        probeName: null,
        id: "hint-1",
        title: null,
        revealed: false,
        unlocked: true,
        bodyMarkdown: null,
      },
      {
        key: "probe:nginx-listening:hint-1",
        scope: "probe",
        probeName: "nginx-listening",
        id: "hint-nginx-1",
        title: null,
        revealed: false,
        unlocked: true,
        bodyMarkdown: null,
      },
    ],
    solution: {
      unlocked: true,
      revealed: complete,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: complete
        ? "Restore the nginx unit, validate its configuration, and restart it."
        : null,
    },
    difficulty: briefing.difficulty,
    estimatedMinutes: briefing.estimatedMinutes,
    solvedAt: solved ? FIXED_NOW - 12 * minute : null,
    solveDurationMs: solved ? 23 * minute : null,
    outcome: lifecycle.outcome,
    active: !background && !complete && state !== "failed",
    activity: background
      ? "background"
      : complete || state === "failed"
        ? "settled"
        : "foreground",
    deleteRequestedAt:
      background || complete ? FIXED_NOW - 2 * minute : null,
    replayState:
      state === "replay"
        ? "ready"
        : state === "ending"
          ? "preparing"
          : complete || state === "failed"
            ? "none"
            : "not_started",
    hasReplay: state === "replay",
    createdAt: FIXED_NOW - 35 * minute,
    updatedAt: FIXED_NOW - minute,
    phase: lifecycle.runPhase,
    phaseTitle: lifecycle.runPhase,
    phaseDetail:
      state === "failed"
        ? "The host reported a terminal failure."
        : "The control plane is reconciling the run.",
    progressPercent: lifecycle.progress,
    terminalPhase: lifecycle.terminal,
    canOpenTerminal: lifecycle.canOpenTerminal,
    canDestroy: lifecycle.canDestroy,
    bootProbes: [bootProbe],
    scenarioProbes: [repairProbe, healthProbe],
    replayArtifacts,
    terminalTarget,
    vms: [
      {
        id: "run-vm-web",
        ordinal: 0,
        scenarioVmId: "vm-web",
        scenarioVmName: "web",
        runtimeVmName: "repair-nginx-web-7f3a",
        hostname: "web",
        phase: lifecycle.vmPhase,
        phaseTitle: lifecycle.vmPhase,
        phaseDetail: "System state reported by the workshop host.",
        progressPercent: lifecycle.progress,
        terminalPhase: lifecycle.terminal,
        terminalReason: state === "failed" ? "guest failed" : null,
        terminalObservedAt: ready ? FIXED_NOW - minute : null,
        canOpenTerminal: lifecycle.canOpenTerminal,
        bootProbes: [bootProbe],
        scenarioProbes: [repairProbe, healthProbe],
        replayArtifacts,
        sessionTimeline:
          state === "replay"
            ? [
                {
                  index: 0,
                  startTimestampMs: FIXED_NOW - 30 * minute,
                  durationMs: 18 * minute,
                  exitCode: 0,
                  castFilename: "session.cast",
                  castArtifactId: "artifact-cast-1",
                  transcriptTruncated: false,
                },
              ]
            : null,
        hasRecording: state === "replay",
        terminalTarget,
        guestIp: ready ? "10.40.0.18" : null,
        launchSummary: {
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: {
            "boot-ready": "boot",
            "nginx-listening": "scenario",
            "health-endpoint": "scenario",
          },
          probeDescriptors: [
            {
              id: "boot-ready",
              label: "Machine ready",
              kind: "systemd_unit",
              phase: "boot",
            },
            {
              id: "nginx-listening",
              label: "nginx listens on port 80",
              kind: "tcp_connect",
              phase: "scenario",
            },
            {
              id: "health-endpoint",
              label: "health endpoint returns ok",
              kind: "http_request",
              phase: "scenario",
            },
          ],
        },
        runtimeState: ready ? "running" : lifecycle.vmPhase,
        runtimeObservedAt: FIXED_NOW - minute,
        vmCreatedAt: FIXED_NOW - 33 * minute,
        provisioning: {
          image: "debian-13",
          imageKey: scenarioVm.imageKey,
          imageSha256: sha,
          resources: { vcpus: 2, memoryMib: 2048, diskMib: 8192 },
          leaseDurationSeconds: 7200,
          groupName: "learner",
          groupId: "group-learner",
          setupKeyId: "setup-key-1",
          status: ready ? "provisioning" : "pending",
          error: state === "failed" ? "guest stopped" : null,
        },
      },
    ],
  };
}
