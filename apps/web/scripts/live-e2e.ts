import { performance } from "node:perf_hooks";
import { ApiClient } from "./live-e2e/api-client";
import { combineManifests, loadManifests } from "./live-e2e/manifest";
import { parseOptions } from "./live-e2e/options";
import {
  loadRequiredImagesFromAdminScenarios,
  publishManifest,
  waitForBuildsSucceeded,
  waitForHostReady,
} from "./live-e2e/setup";
import {
  startRun,
  verifyDistinctVmTerminalKeys,
  verifyRunContentGating,
  verifyTerminalSessions,
  waitForRunReady,
  waitForSameRunPeerIps,
} from "./live-e2e/terminal";
import { teardownAndVerify } from "./live-e2e/teardown";
import type {
  Options,
  RequiredImage,
  VerifiedTerminalSession,
} from "./live-e2e/types";
import { errorMessage, logStep } from "./live-e2e/utils";

export { ApiClient } from "./live-e2e/api-client";
export { parseManifest } from "./live-e2e/manifest";
export { parseOptions } from "./live-e2e/options";
export { hostReadinessProblems } from "./live-e2e/setup";
export type { HostSummary } from "./live-e2e/types";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);
  await runLiveE2e(options);
}

async function runLiveE2e(options: Options): Promise<void> {
  const client = new ApiClient(options.baseUrl, options.cookie);
  const loadedManifests = await loadManifests(options.manifestPaths);
  const manifest = loadedManifests.length
    ? combineManifests(loadedManifests)
    : null;
  let requiredImages: RequiredImage[] = manifest?.vms ?? [];
  const scenarioIdsToVerify = [options.scenarioId];
  const runIdsToTeardown: string[] = [];
  const terminalSessionsByRunId = new Map<string, VerifiedTerminalSession[]>();
  let selectedHostId: string | null = null;
  let mainError: unknown = null;

  try {
    if (!options.skipPublish) {
      if (!manifest) {
        throw new Error("live E2E publish requires at least one --manifest");
      }
      await publishManifest(options, loadedManifests, manifest);
    } else {
      logStep("publish skipped by flag");
    }

    if (options.buildRev) {
      await waitForBuildsSucceeded(
        client,
        options,
        scenarioIdsToVerify,
        requiredImages,
      );
      if (!requiredImages.length) {
        requiredImages = await loadRequiredImagesFromAdminScenarios(
          client,
          scenarioIdsToVerify,
        );
        logStep(
          `loaded ${requiredImages.length} image cache requirement(s) from admin scenarios ${scenarioIdsToVerify.join(",")}`,
        );
      }
    }

    const host = await waitForHostReady(client, options, requiredImages);
    selectedHostId = host.id;
    logStep(`host ready: ${host.id}`);

    const startedAt = performance.now();
    const start = await startRun(client, options, host.id, options.scenarioId);
    const primaryRunId = start.runId;
    runIdsToTeardown.push(primaryRunId);
    const acceptedElapsedMs = Math.round(performance.now() - startedAt);
    logStep(
      `run accepted in ${acceptedElapsedMs}ms: ${primaryRunId}${start.reused ? " (reused active run)" : ""}`,
    );

    const readyRun = await waitForRunReady(
      client,
      primaryRunId,
      options.waitReadyMs,
      options.pollMs,
    );
    const primarySameRunPeerIpsByVmName =
      !options.skipTerminalProbe && readyRun.vms.length > 1
        ? await waitForSameRunPeerIps({
            client,
            hostId: host.id,
            run: readyRun,
            timeoutMs: options.waitReadyMs,
            pollMs: options.pollMs,
          })
        : new Map<string, string[]>();
    const readyElapsedMs = Math.round(performance.now() - startedAt);
    if (readyElapsedMs > options.warmStartBudgetMs) {
      throw new Error(
        `warm start budget exceeded on mandatory fast-template host: ${readyElapsedMs}ms > ${options.warmStartBudgetMs}ms`,
      );
    } else {
      logStep(
        `terminal ready in ${readyElapsedMs}ms (${readyElapsedMs - acceptedElapsedMs}ms after acceptance)`,
      );
    }

    await verifyRunContentGating(client, readyRun);
    await verifyDistinctVmTerminalKeys({
      client,
      hostId: host.id,
      run: readyRun,
      timeoutMs: options.waitReadyMs,
      pollMs: options.pollMs,
    });

    terminalSessionsByRunId.set(
      readyRun.id,
      await verifyTerminalSessions(
        client,
        readyRun,
        options,
        options.forbiddenIps,
        primarySameRunPeerIpsByVmName,
      ),
    );
    logStep("terminal routes and isolation probes verified");
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    if (runIdsToTeardown.length && !options.skipTeardown) {
      let teardownFailure: unknown = null;
      try {
        if (!selectedHostId) {
          throw new Error("teardown host is unavailable");
        }
        for (const teardownRunId of [...runIdsToTeardown].reverse()) {
          await teardownAndVerify(
            client,
            selectedHostId,
            teardownRunId,
            options,
            terminalSessionsByRunId.get(teardownRunId) ?? [],
          );
        }
      } catch (teardownError) {
        if (!mainError) {
          teardownFailure = teardownError;
        } else {
          logStep(
            `teardown verification failed after primary error: ${errorMessage(teardownError)}`,
          );
        }
      }
      if (!mainError && teardownFailure) {
        throw teardownFailure;
      }
    } else if (runIdsToTeardown.length) {
      logStep(`teardown skipped for run(s) ${runIdsToTeardown.join(",")}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[live-e2e] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
