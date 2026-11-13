// Ingest of a `SourceBundleV2` into one scope: the bundle object, its row,
// a building revision per scenario with its spec blobs, the scenarios and a
// queued build per unseen or failed build key. Every ID is `<namespace>/<slug>`, and
// the namespace comes from the binding, never from the bundle. The first
// stored bytes of a rev are the only ones its rows describe, and every write
// is idempotent, so a repeat completes a partial earlier attempt and
// otherwise changes nothing.

import { normalizeCourseCatalogSnapshot } from "@/control-plane/image-registry/bundle";
import { GUEST_CONTRACT, IMAGE_FORMAT, MACHINE_SPEC_MEDIA_TYPE, PLATFORM_BASE_IMAGE, SOURCE_COMPILER_VERSION_V2 } from "@/generated/constants";
import type { BuildTargetV1 } from "@/generated/contracts/bridge-message-v9";
import { AppError } from "@/lib/app-error";
import { courseCatalogScopeKey } from "@/lib/course-catalogs";
import { baseKey, buildKeys } from "@/lib/scenario-contract/build-key";
import { canonicalJson } from "@/lib/scenario-contract/canonical-json";
import { machineSpec, scenarioRevision, specBlob } from "@/lib/scenario-contract/machine-spec";
import { readSourceBundle } from "@/lib/scenario-contract/source-bundle";
import { maintainMachineBuilds, settleScenarioRevisions } from "@/lib/machine-builds";

/** The namespace of the public scope. */
export const PUBLIC_NAMESPACE = "intar";
// The organization slug charset, up to the 55 characters existing slugs use.
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/;

export function sourceBundleObjectKey(rev: string): string {
  return `builds/bundles/${rev}.json.gz`;
}

/** Where a content-addressed blob lives; the registry uses the same prefix. */
export function ociBlobKey(digest: string): string {
  return `oci/sha256/${digest.slice("sha256:".length)}`;
}

/**
 * Ingests the bundle `gzip` as `rev` for the scope of `organizationId`
 * (null is public). Answers null when done, or why the bundle is refused;
 * every refusal comes before the first write. `stored` says the gzip is the
 * object already at its key. Otherwise it is stored only where no object is
 * yet; when one is, the ingest runs from that object instead.
 */
export async function ingestSourceBundle(
  env: Pick<Cloudflare.Env, "DB" | "VM_IMAGE_REGISTRY_BUCKET">,
  input: {
    organizationId: string | null;
    rev: string;
    gzip: Uint8Array<ArrayBuffer>;
    stored: boolean;
  },
): Promise<string | null> {
  const { organizationId, rev } = input;
  const scopeKey = courseCatalogScopeKey(organizationId);
  let bundle;
  try {
    bundle = await readSourceBundle(input.gzip);
  } catch (error) {
    if (error instanceof AppError) return error.message;
    throw error;
  }
  if (!normalizeCourseCatalogSnapshot(bundle.course_catalog)) return "the course catalog is invalid";

  const owner =
    organizationId === null
      ? { slug: PUBLIC_NAMESPACE }
      : await env.DB.prepare("SELECT slug FROM organization WHERE id = ?1")
          .bind(organizationId)
          .first<{ slug: string }>();
  const namespace = owner?.slug ?? "";
  if (!NAMESPACE.test(namespace) || (organizationId !== null && namespace === PUBLIC_NAMESPACE)) {
    return `the organization slug \`${namespace}\` is not a scenario namespace`;
  }
  const id = (slug: string) => `${namespace}/${slug}`;

  const ids = bundle.scenarios.map((scenario) => id(scenario.slug));
  const [foreignBundle, foreignScenario] = await Promise.all([
    env.DB.prepare("SELECT 1 FROM bundles WHERE rev = ?1 AND scope_key IS NOT ?2")
      .bind(rev, scopeKey)
      .first(),
    env.DB.prepare(
      `SELECT id FROM scenarios
        WHERE id IN (SELECT value FROM json_each(?1)) AND scope_key IS NOT ?2 LIMIT 1`,
    )
      .bind(JSON.stringify(ids), scopeKey)
      .first<{ id: string }>(),
  ]);
  if (foreignBundle) return "this commit is owned by another scope";
  if (foreignScenario) return `scenario \`${foreignScenario.id}\` belongs to another scope`;

  const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
  const objectKey = sourceBundleObjectKey(rev);
  if (!input.stored) {
    const put = await bucket.put(objectKey, input.gzip, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { rev },
    });
    // Another try stored this rev first: its bytes are the rev's.
    if (put === null) {
      const stored = await bucket.get(objectKey);
      if (!stored) throw new Error(`bundle ${rev} is neither absent nor present`);
      return ingestSourceBundle(env, { ...input, gzip: new Uint8Array(await stored.arrayBuffer()), stored: true });
    }
  }

  const base = await baseKey();
  const specs = new Map<string, string>();
  const builds = new Map<string, BuildTargetV1>();
  const scenarios = [];
  for (const scenario of bundle.scenarios) {
    const scenarioId = id(scenario.slug);
    const keys = await buildKeys(scenario, bundle.images);
    for (const machine of scenario.machines) {
      for (const mode of ["learn", "verify"] as const) {
        const spec = machineSpec(scenario, scenarioId, machine.name, mode);
        if (spec) {
          const blob = await specBlob(spec);
          specs.set(blob.digest, blob.json);
        }
      }
      const key = keys.machines[machine.name]!;
      if (!builds.has(key)) {
        builds.set(
          key,
          key === base
            ? { kind: "image", name: PLATFORM_BASE_IMAGE }
            : { kind: "machine", scenario: scenario.slug, machine: machine.name },
        );
      }
    }
    // Under D1's value limit: readSourceBundle refuses a larger document.
    const doc = canonicalJson(await scenarioRevision(scenario, scenarioId, keys));
    scenarios.push({ id: scenarioId, slug: scenario.slug, play: scenario.play, doc });
  }

  // ponytail: one put per distinct spec, up to 1,600 for 100 scenarios of
  // 8 machines; batch through a queue if bundles grow near that.
  await Promise.all(
    [...specs].map(([digest, json]) =>
      bucket.put(ociBlobKey(digest), json, {
        httpMetadata: { contentType: MACHINE_SPEC_MEDIA_TYPE },
        customMetadata: { media_type: MACHINE_SPEC_MEDIA_TYPE, size: String(new TextEncoder().encode(json).byteLength) },
      }),
    ),
  );

  // The bundle's course catalog is not applied here: learners read
  // course_catalogs, and no revision of this rev is ready yet. Promotion
  // applies it from the stored bundle, each lecture `scenario_id` written as
  // `<namespace>/<slug>`.
  const now = Date.now();
  // One transaction, one statement per revision so no bound value carries
  // more than one document. `WHERE true` keeps SQLite from reading ON
  // CONFLICT as a join constraint of the SELECT.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bundles (rev, scope_key, organization_id, compiler_version, r2_key, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (rev) DO NOTHING`,
    ).bind(rev, scopeKey, organizationId, SOURCE_COMPILER_VERSION_V2, objectKey, now),
    env.DB.prepare(
      `INSERT INTO scenarios (id, namespace, slug, organization_id, scope_key, enabled, play, updated_at)
        SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.slug'), ?3, ?4, 1,
          json_extract(value, '$.play'), ?5
        FROM json_each(?1) WHERE true ON CONFLICT (id) DO NOTHING`,
    ).bind(
      JSON.stringify(scenarios.map(({ id: scenarioId, slug, play }) => ({ id: scenarioId, slug, play }))),
      namespace,
      organizationId,
      scopeKey,
      now,
    ),
    // Only under a scenario of this scope, so no other scope gains a revision.
    ...scenarios.map((scenario) =>
      env.DB.prepare(
        `INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
          SELECT ?1, ?2, ?3, ?4, 'building', ?5
          WHERE EXISTS (SELECT 1 FROM scenarios WHERE id = ?1 AND scope_key = ?6)
          ON CONFLICT (scenario_id, rev) DO NOTHING`,
      ).bind(scenario.id, rev, GUEST_CONTRACT, scenario.doc, now, scopeKey),
    ),
    env.DB.prepare(
      `INSERT INTO machine_builds (build_key, image_format, bundle_rev, target_json, state, attempt,
          created_at, updated_at)
        SELECT key, ?2, ?3, value, 'queued', 0, ?4, ?4 FROM json_each(?1)
        WHERE true ON CONFLICT (build_key) DO UPDATE SET state = 'queued', host_id = NULL, phase = NULL,
          error = NULL, bundle_rev = excluded.bundle_rev, target_json = excluded.target_json,
          updated_at = excluded.updated_at
        WHERE machine_builds.state = 'failed'`,
    ).bind(
      JSON.stringify(Object.fromEntries([...builds].map(([key, target]) => [key, JSON.stringify(target)]))),
      IMAGE_FORMAT,
      rev,
      now,
    ),
  ]);
  // A revision whose images all exist is ready now; the rest wait for the
  // builds just queued.
  await settleScenarioRevisions(env, { rev });
  await maintainMachineBuilds(env, null, now);
  return null;
}
