import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { createScenarioSshSessionForUser } from "@/lib/scenario-runs";
import { normalizeTemporaryNativeSshPublicKey } from "@/lib/user-ssh-keys";

interface ScenarioSshBody {
  vmId?: unknown;
  mode?: unknown;
  clientPublicKeyOpenssh?: unknown;
}

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, { status: 400 });
  }
  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    Array.isArray(parsedBody)
  ) {
    return jsonResponse(
      { error: "json body must be an object" },
      { status: 400 },
    );
  }
  const body = parsedBody as ScenarioSshBody;

  const vmId = typeof body.vmId === "string" ? body.vmId.trim() : "";
  const mode =
    body.mode === "native" || body.mode === "browser" ? body.mode : "browser";
  if (!vmId) {
    return jsonResponse({ error: "vmId is required" }, { status: 400 });
  }
  if (
    body.clientPublicKeyOpenssh !== undefined &&
    typeof body.clientPublicKeyOpenssh !== "string"
  ) {
    return jsonResponse(
      { error: "clientPublicKeyOpenssh must be a string" },
      { status: 400 },
    );
  }
  if (body.clientPublicKeyOpenssh !== undefined && mode !== "native") {
    return jsonResponse(
      { error: "clientPublicKeyOpenssh is only supported for native SSH" },
      { status: 400 },
    );
  }

  try {
    const clientPublicKeyOpenssh =
      typeof body.clientPublicKeyOpenssh === "string"
        ? await normalizeTemporaryNativeSshPublicKey(
            body.clientPublicKeyOpenssh,
          )
        : undefined;
    const session = await createScenarioSshSessionForUser({
      runId,
      vmId,
      userId: authz.context.userId,
      mode,
      ...(clientPublicKeyOpenssh ? { clientPublicKeyOpenssh } : {}),
    });
    return jsonResponse(session);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to create scenario shell",
    );
    return jsonResponse(body, { status });
  }
};
