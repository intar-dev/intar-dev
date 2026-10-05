import { traceOperation } from "@/lib/tracing";
import { recordSecurityResponse } from "@/lib/security-events";
import { handle } from "@astrojs/cloudflare/handler";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleHostEnrollment } from "@/control-plane/host-enrollment";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { handleAgentRunCliRequest } from "@/control-plane/run-cli";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";
import { RunShareDO } from "@/control-plane/run-share-do";
import { SHARE_INGEST_PATH } from "@/lib/run-share/protocol";
import { handleShareIngest } from "@/lib/run-share/service";
import {
  ScenarioSourceDO,
  sweepScenarioSources,
} from "@/control-plane/scenario-source-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { advanceImagePromotion } from "@/control-plane/image-promotion";
import {
  GITHUB_WEBHOOK_PATH,
  handleGitHubWebhook,
} from "@/control-plane/github-webhook";
import {
  handleMaintenanceMode,
  handleRegistryCleanupGateRequest,
} from "@/maintenance";
import { MaintenanceState } from "@/maintenance-state";
import { sweepUndeliveredHostDesiredState } from "@/lib/host-runtime-dispatch-outbox";
import {
  guardCanonicalRequestPath,
  secureApplicationApiRequest,
} from "@/lib/request-security";
import { hardenWorkerResponse } from "@/lib/response-security";

export default {
  async fetch(request, env, ctx) {
    const respond = (response: Response) => {
      recordSecurityResponse(request, response);
      return hardenWorkerResponse(request, response, env);
    };
    const canonicalPath = guardCanonicalRequestPath(request);
    if (!canonicalPath.ok) return respond(canonicalPath.response);

    const maintenanceResponse = await traceOperation("request.maintenance", () => handleMaintenanceMode(request, env));
    if (maintenanceResponse) return respond(maintenanceResponse);

    // The image registry deployment gate sits behind the fence on purpose: it
    // is unreachable while maintenance is on, so a deployment holds the
    // collector before the fence closes and releases it after the parent
    // serves again. It registers before the application so this path never
    // reaches Astro.
    const cleanupGateResponse = await traceOperation("registry.cleanup.gate", () =>
      handleRegistryCleanupGateRequest(request, env),
    );
    if (cleanupGateResponse) return respond(cleanupGateResponse);

    const url = new URL(request.url);

    if (url.pathname === "/agent/enroll") {
      return respond(await traceOperation("agent.enroll", () => handleHostEnrollment(request, env)));
    }

    if (
      url.pathname === "/agent/bootstrap" ||
      url.pathname === "/api/agent/bootstrap"
    ) {
      return respond(await traceOperation("agent.authenticate", () => handleAgentBootstrap(request, env)));
    }

    if (
      url.pathname === "/agent/connect" ||
      url.pathname === "/api/agent/connect"
    ) {
      return respond(await traceOperation("agent.connect", () => handleAgentConnect(request, env)));
    }

    const registryResponse = await traceOperation("image.registry", () => handleImageRegistryRequest(request, env));
    if (registryResponse) {
      return respond(registryResponse);
    }

    if (url.pathname.startsWith("/agent/runs")) {
      const runCliResponse = await traceOperation("run.cli", () => handleAgentRunCliRequest(request, env));
      if (runCliResponse) {
        return respond(runCliResponse);
      }
      const response = await traceOperation("run.artifacts", () => handleAgentRunArtifactRequest(request, env));
      if (response) {
        return respond(response);
      }
    }

    // Stargate streams shared runs with a per-share bearer token that the
    // share itself checks; it is not a browser API call.
    if (url.pathname === SHARE_INGEST_PATH) {
      return respond(await traceOperation("share.ingest", () => handleShareIngest(request)));
    }

    // GitHub signs its deliveries instead of sending browser credentials, so
    // the webhook answers before the application API security layer.
    if (url.pathname === GITHUB_WEBHOOK_PATH) {
      return respond(await traceOperation("github.webhook", () => handleGitHubWebhook(request, env)));
    }

    const securedRequest = await traceOperation("request.security", () => secureApplicationApiRequest(request, env));
    if (!securedRequest.ok) return respond(securedRequest.response);

    const response = await traceOperation("app.handle", () => handle(securedRequest.request, env, ctx));
    return respond(response);
  },
  async scheduled(_controller, env) {
    // Planned control-plane maintenance must be database-independent. Cron work
    // is part of the same maintenance fence as HTTP traffic; otherwise a minute
    // tick can issue or mutate runtimes while the control plane is fenced.
    if (String(env.CONTROL_PLANE_MAINTENANCE) === "on") {
      console.info(JSON.stringify({ event: "scheduled_maintenance_fenced" }));
      return;
    }
    // The durable dispatch outbox is the committed host desired-state version.
    // The wake that follows a commit is only a latency hint, so this sweep is
    // what recovers a delivery that a crash, a lost alarm, or a dead socket
    // dropped. It is bounded and idempotent: a wake for an already applied
    // version sends nothing.
    try {
      await sweepUndeliveredHostDesiredState();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "host_desired_dispatch_sweep_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    try {
      await sweepScenarioSources(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scenario_source_sweep_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    // After the sources, so a commit that just reached awaiting_promote is
    // seen in the same tick.
    try {
      await advanceImagePromotion(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "image_promotion_tick_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO, MaintenanceState, RunShareDO, ScenarioSourceDO };
