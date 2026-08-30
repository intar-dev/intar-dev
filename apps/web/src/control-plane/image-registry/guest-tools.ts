import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts } from "@/db/schema";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import {
  desiredGuestTools,
  parseScenarioGuestToolsPin,
  scenarioGuestToolsPinKey,
  scenarioKinoObjectKey,
  scenarioToolsDiskObjectKey,
  verifyScenarioGuestToolsObjects,
} from "@/lib/scenario-guest-tools";
import { hasRegistryPublishToken, jsonResponse, sha256Hex } from "./shared";

const PROMOTION_CONCURRENCY = 4;

export async function handleScenarioGuestToolsPromotion(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  return convergeScenarioGuestTools(request, env, true);
}

export async function handleScenarioGuestToolsWarm(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  return convergeScenarioGuestTools(request, env, false);
}

async function convergeScenarioGuestTools(
  request: Request,
  env: Cloudflare.Env,
  promoteStable: boolean,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!(await hasRegistryPublishToken(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const candidateObject = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    scenarioGuestToolsPinKey("candidate"),
  );
  if (!candidateObject) {
    return jsonResponse({ error: "candidate guest-tools pin is unavailable" }, 409);
  }
  const candidateBytes = await candidateObject.arrayBuffer();
  let pin;
  try {
    pin = parseScenarioGuestToolsPin(
      JSON.parse(new TextDecoder().decode(candidateBytes)),
      "candidate",
    );
    await verifyScenarioGuestToolsObjects(env, pin, "candidate");
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "candidate pin is invalid" },
      409,
    );
  }

  const [compressedDisk, kino] = await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.get(
      scenarioToolsDiskObjectKey(pin.tools_disk_sha256),
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.get(scenarioKinoObjectKey(pin.kino_sha256)),
  ]);
  if (!compressedDisk || !kino) {
    return jsonResponse({ error: "candidate guest-tools objects are unavailable" }, 409);
  }
  const [compressedDiskBytes, kinoBytes] = await Promise.all([
    compressedDisk.arrayBuffer(),
    kino.arrayBuffer(),
  ]);
  if (
    compressedDiskBytes.byteLength !== pin.compressed_disk_size_bytes ||
    (await sha256Hex(compressedDiskBytes)) !== pin.compressed_disk_sha256 ||
    kinoBytes.byteLength !== pin.kino_size_bytes ||
    (await sha256Hex(kinoBytes)) !== pin.kino_sha256
  ) {
    return jsonResponse({ error: "candidate guest-tools object digest mismatch" }, 409);
  }

  const desired = desiredGuestTools(pin);
  const now = Date.now();
  const db = drizzle(env.DB);
  const hosts = await db
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(and(eq(agentHosts.role, "agent"), eq(agentHosts.disabled, false)));
  const updatedHostIds: string[] = [];
  for (let offset = 0; offset < hosts.length; offset += PROMOTION_CONCURRENCY) {
    await Promise.all(
      hosts.slice(offset, offset + PROMOTION_CONCURRENCY).map(async (host) => {
        await mutateStoredHostDesiredState(
          db,
          host.id,
          now,
          (draft) => {
            draft.cached_guest_tools = [{ ...desired }];
          },
        );
        updatedHostIds.push(host.id);
        await tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, host.id);
      }),
    );
  }

  if (promoteStable) {
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      scenarioGuestToolsPinKey("stable"),
      candidateBytes,
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  return jsonResponse({
    ok: true,
    ...(promoteStable ? { stable: desired } : { candidate: desired }),
    warmed_host_ids: hosts.map((host) => host.id).sort(),
    updated_host_ids: updatedHostIds.sort(),
  });
}
