import { preparationAuthoritySql } from "@/lib/personal-image-access";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, personalImagePreparations, user } from "@/db/schema";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import { appError } from "@/lib/app-error";
import { mutateDesiredState, upsertDesiredCachedImage } from "@/lib/desired-state";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import type { RuntimeResourceDemand } from "@/lib/runtime-capacity";
import type { AdmissionContentAccess } from "@/lib/scenario-runs/admission-guards";
import { loadScenarioLaunchHostForUser, selectScenarioHosts } from "@/lib/scenario-runs/start";
import type { RequiredScenarioImage } from "@/lib/scenario-host-readiness";

export const PERSONAL_IMAGE_PREPARATION_TTL_MS = 15 * 60_000;

/** Called only by an authorized start; it creates no run and starts no polling. */
export async function preparePersonalScenarioImages(input: {
  access: AdmissionContentAccess;
  betaAdmission: BetaAdmissionEpoch;
  requestKey: string;
  requestedHostId?: string;
  requiredImages: RequiredScenarioImage[];
  requiredResources: RuntimeResourceDemand;
}): Promise<string | undefined> {
  const db = drizzle(env.DB);
  const [owner] = await db.select({ placement: user.metalPlacement }).from(user)
    .where(eq(user.id, input.access.userId)).limit(1);
  if (owner?.placement !== "personal") return undefined;

  const [pending] = await db.select().from(personalImagePreparations)
    .where(eq(personalImagePreparations.userId, input.access.userId)).limit(1);
  let hostId = input.requestedHostId;
  if (hostId) {
    await loadScenarioLaunchHostForUser(hostId, input.access.userId, []);
  } else {
    // Prefer a host which already has the images, then keep an eligible
    // pending host stable across retries. Only one host receives a grant.
    let selection = await selectScenarioHosts(input.requiredImages, input.access.userId, input.requiredResources);
    if (!selection.ok) selection = await selectScenarioHosts([], input.access.userId, input.requiredResources);
    if (!selection.ok) return undefined; // The normal admission path supplies the error copy.
    hostId = pending?.requestKey === input.requestKey && selection.hostIds.includes(pending.hostId)
      ? pending.hostId : selection.hostIds[0];
  }
  if (!hostId) return undefined;
  const [host] = await db.select().from(agentHosts)
    .where(and(eq(agentHosts.id, hostId), eq(agentHosts.userId, input.access.userId), eq(agentHosts.scope, "personal"))).limit(1);
  if (!host) throw preparationChanged();

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const current = await loadOrCreateHostDesiredState(db, host.id, now);
    const next = mutateDesiredState(current, draft => {
      // Preparation is one exact requested workload. Running VMs keep their
      // own image references; an old preparation must not retain access.
      draft.cached_images = [];
      for (const image of input.requiredImages) {
        upsertDesiredCachedImage(draft, { image_key: image.imageKey, image_id: image.imageSha256 });
      }
    }, { nowUnixMs: now });
    // Bump even an unchanged document: the version serializes a new grant
    // against admission and lets a retry deliver failed cache work again.
    const desired = next === current
      ? { ...next, version: current.version + 1, generated_at_unix_ms: now } : next;
    const values = [input.access.userId, host.id, host.credentialGeneration,
      input.requestKey, JSON.stringify(input.access), JSON.stringify(input.betaAdmission),
      JSON.stringify(input.requiredImages), now + PERSONAL_IMAGE_PREPARATION_TTL_MS];
    const columns = "user_id, host_id, credential_generation, request_key, access_json, beta_json, images_json, expires_at";
    const [updated] = await env.DB.batch([
      env.DB.prepare(`WITH prep (${columns}) AS (VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8))
        UPDATE host_desired_state SET version = ?9, doc_json = ?10, updated_at = ?11
        WHERE host_id = ?2 AND version = ?12 AND EXISTS (SELECT 1 FROM prep
          WHERE ${preparationAuthoritySql()}
            AND json_array_length(prep.images_json) > 0
            AND NOT EXISTS (SELECT 1 FROM json_each(prep.images_json) image
              WHERE NOT EXISTS (SELECT 1 FROM vm_scenario_vms vm
                WHERE vm.scenario_id = json_extract(prep.access_json, '$.scenarioId')
                  AND vm.image_sha256 = json_extract(image.value, '$.imageSha256')
                  AND json_extract(vm.image_key_json, '$.scenario') = json_extract(image.value, '$.imageKey.scenario')
                  AND json_extract(vm.image_key_json, '$.vm') = json_extract(image.value, '$.imageKey.vm')
                  AND json_extract(vm.image_key_json, '$.arch') = json_extract(image.value, '$.imageKey.arch'))))
        RETURNING host_id`).bind(...values, desired.version, JSON.stringify(desired), now, current.version),
      env.DB.prepare(`INSERT INTO personal_image_preparations (${columns})
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE changes() = 1
        ON CONFLICT(user_id) DO UPDATE SET host_id = excluded.host_id,
          credential_generation = excluded.credential_generation, request_key = excluded.request_key,
          access_json = excluded.access_json, beta_json = excluded.beta_json,
          images_json = excluded.images_json, expires_at = excluded.expires_at`).bind(...values),
    ]);
    if (!updated?.results.length) continue;
    await tryWakeHostRuntime(host.id);
    return host.id;
  }
  throw preparationChanged();
}

function preparationChanged() {
  return appError(409, "scenario_preparation_changed", "Your server or course access changed. Start the run again.");
}
