// Machine builds for bridge 9 builders. `machine_builds` is the queue and
// the truth: a builder's desired `builds` mirror its assigned rows, and a
// build's attempt goes up each time it is assigned. A build's id on the
// bridge and on the push routes is its build key's hex.
//
// A row moves queued → assigned → building → succeeded or failed. Only the
// result POST writes `image_digest`; a succeeded report must name that
// digest. The Worker owns retries: a build whose builder reported a failure,
// went silent or went away is assigned again with the next attempt, up to
// MAX_MACHINE_BUILD_ATTEMPTS. One whose image is already recorded succeeded,
// whatever the builder says afterwards.

import { drizzle } from "drizzle-orm/d1";
import { IMAGE_FORMAT } from "@/generated/constants";
import type {
  BuildPhaseV2,
  BuildReportV2,
  BuildTargetV1,
  DesiredBuildV2,
  DesiredSourceCompileV2,
} from "@/generated/contracts/bridge-message-v9";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
import { HOST_DESIRED_STATE_SCHEMA_VERSION_V3, mutateHostDesiredStateV3 } from "@/lib/desired-state-store";
import { HOST_DEGRADED_AFTER_MS } from "@/lib/host-health";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { canonicalJson, sha256Digest } from "@/lib/scenario-contract/canonical-json";

export const MAX_MACHINE_BUILD_ATTEMPTS = 3;
/** A build or compile whose builder stayed away this long is taken back. */
export const BUILDER_REASSIGN_AFTER_MS = 10 * 60 * 1000;
const BUILD_REPORT_STALE_AFTER_MS = 30 * 60 * 1000;
/** intar-builder's maximum build workers (main.rs validate_job_config). */
const BUILDER_BUILD_SLOTS = 2;
/** What a learner or tenant reads about a revision whose image failed. */
export const REVISION_BUILD_FAILURE = "An image of this scenario failed to build.";
const MAX_BUILD_ERROR_CHARS = 4096;
// The builder replays its reports on every heartbeat, so a build without a
// report for BUILD_REPORT_STALE_AFTER_MS lost its builder. One attempt may
// still not run forever: the builder's worst case is a fetch, the provision
// boot (provision_timeout_seconds, 40 min by default), for a wake image a
// second boot under the same timeout, a QEMU exit wait (5 min) after each,
// and the push with 5 min per request. Three hours is above that sum.
const MACHINE_BUILD_ATTEMPT_CEILING_MS = 3 * 60 * 60 * 1000;
const ASSIGN_BATCH = 100;

type Env = Pick<Cloudflare.Env, "DB">;

// A builder that may take a build of this Worker's image format.
const FREE_BUILDER = `host.role = 'builder' AND host.scope = 'platform' AND host.disabled = 0
  AND host.connected = 1 AND host.active_session_id IS NOT NULL
  AND json_extract(host.hello_json, '$.builder.image_format') = ?`;

/**
 * Releases expired builds, assigns queued ones, and brings each builder
 * whose builds changed up to date; `selfHostId` is synced but not woken,
 * since its own runtime calls this and dispatches afterwards.
 */
export async function maintainMachineBuilds(env: Env, selfHostId: string | null, now: number): Promise<void> {
  const changed = new Set([...(await expireMachineBuildLeases(env, now)), ...(await assignQueuedMachineBuilds(env, now))]);
  if (selfHostId) changed.add(selfHostId);
  for (const hostId of changed) {
    if ((await syncBuilderDesiredState(env, hostId, now)) && hostId !== selfHostId) await tryWakeHostRuntime(hostId);
  }
}

/**
 * Makes a bridge 9 builder's desired `builds` and `source_compiles` mirror
 * its assigned build rows and compiling source rows. Another host's
 * document is left alone. True when it changed.
 */
export async function syncBuilderDesiredState(env: Env, hostId: string, now: number): Promise<boolean> {
  const [schema, builds, compiles] = await env.DB.batch([
    env.DB.prepare(
      `SELECT json_extract(state.doc_json, '$.schema_version') AS schema FROM host_desired_state state
        JOIN agent_hosts host ON host.id = state.host_id AND host.role = 'builder'
        WHERE state.host_id = ?1`,
    ).bind(hostId),
    env.DB.prepare(
      `SELECT build_key, bundle_rev, target_json, attempt FROM machine_builds
        WHERE host_id = ?1 AND state IN ('assigned', 'building') ORDER BY build_key`,
    ).bind(hostId),
    env.DB.prepare(
      `SELECT id, attempt, rev, purpose FROM scenario_source_commits
        WHERE compile_host_id = ?1 AND state = 'compiling' ORDER BY id`,
    ).bind(hostId),
  ]);
  if ((schema?.results[0] as { schema?: number } | undefined)?.schema !== HOST_DESIRED_STATE_SCHEMA_VERSION_V3) return false;
  const wantedBuilds = (builds!.results as Array<{ build_key: string; bundle_rev: string; target_json: string; attempt: number }>)
    .map((row): DesiredBuildV2 => ({
      build_id: row.build_key.slice("sha256:".length),
      build_key: row.build_key,
      bundle_rev: row.bundle_rev,
      target: JSON.parse(row.target_json) as BuildTargetV1,
      attempt: row.attempt,
    }));
  const wantedCompiles = (compiles!.results as Array<{ id: string; attempt: number; rev: string; purpose: string }>)
    .map((row): DesiredSourceCompileV2 => ({
      compile_id: row.id,
      attempt: row.attempt,
      rev: row.rev,
      validate_only: row.purpose === "validate",
    }));
  let changed = false;
  await mutateHostDesiredStateV3(drizzle(env.DB), hostId, now, (draft) => {
    changed = JSON.stringify([draft.builds, draft.source_compiles]) !== JSON.stringify([wantedBuilds, wantedCompiles]);
    draft.builds = wantedBuilds;
    draft.source_compiles = wantedCompiles;
  });
  return changed;
}

/**
 * Connected, healthy platform builders on this source compile digest with no
 * compile in flight, least loaded first. A builder whose last report predates
 * its hello is not counted as connected yet.
 */
export async function freeSourceCompileBuilders(env: Env, now: number, compileDigest: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT host.id FROM agent_hosts host JOIN host_actual_state state ON state.host_id = host.id
      WHERE host.role = 'builder' AND host.scope = 'platform' AND host.disabled = 0
        AND host.connected = 1 AND host.active_session_id IS NOT NULL
        AND state.updated_at >= host.last_client_hello_at AND state.updated_at >= ?2
        AND json_extract(host.hello_json, '$.builder.source_compile_digest') = ?1
        AND NOT EXISTS (SELECT 1 FROM scenario_source_commits busy
          WHERE busy.compile_host_id = host.id AND busy.state = 'compiling')
      ORDER BY (SELECT count(*) FROM machine_builds build
          WHERE build.host_id = host.id AND build.state IN ('assigned', 'building')), host.id`,
  ).bind(compileDigest, now - HOST_DEGRADED_AFTER_MS).all<{ id: string }>();
  return results.map((row) => row.id);
}

/**
 * Assigns queued builds of this image format to free builders, least loaded
 * first, at most BUILDER_BUILD_SLOTS each. The claim rechecks the builder
 * and its load, so concurrent passes never overfill one. Returns the
 * builders that got a build.
 */
export async function assignQueuedMachineBuilds(env: Env, now: number): Promise<string[]> {
  const [builders, queued] = await env.DB.batch([
    env.DB.prepare(
      `SELECT host.id, (SELECT count(*) FROM machine_builds build
          WHERE build.host_id = host.id AND build.state IN ('assigned', 'building')) AS load
        FROM agent_hosts host WHERE ${FREE_BUILDER}`,
    ).bind(IMAGE_FORMAT),
    env.DB.prepare(
      `SELECT build_key FROM machine_builds WHERE state = 'queued' AND image_format = ?1
        ORDER BY created_at, build_key LIMIT ${ASSIGN_BATCH}`,
    ).bind(IMAGE_FORMAT),
  ]);
  const free = builders!.results as Array<{ id: string; load: number }>;
  const assigned = new Set<string>();
  for (const { build_key: buildKey } of queued!.results as Array<{ build_key: string }>) {
    const builder = free
      .filter((candidate) => candidate.load < BUILDER_BUILD_SLOTS)
      .sort((left, right) => left.load - right.load || left.id.localeCompare(right.id))[0];
    if (!builder) break;
    const claimed = await env.DB.prepare(
      `UPDATE machine_builds SET state = 'assigned', host_id = ?2, attempt = attempt + 1, phase = NULL,
          error = NULL, log_key = NULL, assigned_at = ?3, updated_at = ?3
        WHERE build_key = ?1 AND state = 'queued'
          AND (SELECT count(*) FROM machine_builds slot
            WHERE slot.host_id = ?2 AND slot.state IN ('assigned', 'building')) < ?4
          AND EXISTS (SELECT 1 FROM agent_hosts host WHERE host.id = ?2 AND ${FREE_BUILDER.replace("?", "?5")})
        RETURNING build_key`,
    ).bind(buildKey, builder.id, now, BUILDER_BUILD_SLOTS, IMAGE_FORMAT).first();
    // A concurrent pass filled the builder or took the build; the next pass
    // reads the real load.
    builder.load = claimed ? builder.load + 1 : BUILDER_BUILD_SLOTS;
    if (claimed) assigned.add(builder.id);
  }
  return [...assigned];
}

/**
 * Takes back the builds whose builder went silent for
 * BUILD_REPORT_STALE_AFTER_MS, stayed away for BUILDER_REASSIGN_AFTER_MS,
 * was disabled or removed, and attempts older than
 * MACHINE_BUILD_ATTEMPT_CEILING_MS. One whose image is already recorded succeeded;
 * one out of attempts failed; any other is queued again. Returns the
 * builders that lost a build.
 */
export async function expireMachineBuildLeases(env: Env, now: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT build_key, host_id, attempt, image_digest FROM machine_builds build
      WHERE state IN ('assigned', 'building') AND (host_id IS NULL OR updated_at <= ?1 OR assigned_at <= ?3
        OR EXISTS (SELECT 1 FROM agent_hosts host WHERE host.id = build.host_id
          AND (host.disabled = 1 OR (host.connected = 0 AND host.disconnected_at <= ?2))))`,
  ).bind(now - BUILD_REPORT_STALE_AFTER_MS, now - BUILDER_REASSIGN_AFTER_MS, now - MACHINE_BUILD_ATTEMPT_CEILING_MS)
    .all<{ build_key: string; host_id: string | null; attempt: number; image_digest: string | null }>();
  const released = new Set<string>();
  for (const build of results) {
    const state = build.image_digest ? "succeeded" : build.attempt >= MAX_MACHINE_BUILD_ATTEMPTS ? "failed" : "queued";
    const moved = await env.DB.prepare(
      `UPDATE machine_builds SET state = ?4, host_id = CASE WHEN ?4 = 'queued' THEN NULL ELSE host_id END,
          log_key = CASE WHEN ?4 = 'queued' THEN NULL ELSE log_key END,
          error = CASE ?4 WHEN 'succeeded' THEN error ELSE ?5 END, updated_at = ?6
        WHERE build_key = ?1 AND host_id IS ?2 AND attempt = ?3 AND state IN ('assigned', 'building')
        RETURNING build_key`,
    ).bind(build.build_key, build.host_id, build.attempt, state,
      state === "failed" ? "the build did not finish in any attempt" : "the builder stopped reporting the build", now).first();
    if (!moved) continue;
    if (build.host_id) released.add(build.host_id);
    if (state !== "queued") await settleScenarioRevisions(env, { buildKey: build.build_key });
  }
  return [...released];
}

/**
 * Applies one build report of `hostId`. Only the build's assigned builder,
 * on its current session and for the current attempt, moves it; anything
 * else is ignored. A succeeded report must name the digest the result POST
 * recorded. A replayed phase only marks the build alive. A failure succeeds
 * when the attempt's image is recorded, queues the next attempt while one
 * is left, and fails the build after the last. True when the build moved.
 */
export async function recordMachineBuildReport(
  env: Env,
  hostId: string,
  report: BuildReportV2,
  session: { sessionId: string; credentialGeneration: number },
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(report.build_id) || report.build_key !== `sha256:${report.build_id}`) return false;
  if ((report.phase === "succeeded") !== Boolean(report.image_digest)) return false;
  const row = await env.DB.prepare(
    `SELECT build.state, build.phase, build.attempt, build.image_digest FROM machine_builds build
      JOIN agent_hosts host ON host.id = build.host_id
      WHERE build.build_key = ?1 AND build.host_id = ?2 AND host.role = 'builder' AND host.scope = 'platform'
        AND host.disabled = 0 AND host.active_session_id = ?3 AND host.credential_generation = ?4`,
  ).bind(report.build_key, hostId, session.sessionId, session.credentialGeneration)
    .first<{ state: string; phase: BuildPhaseV2 | null; attempt: number; image_digest: string | null }>();
  if (!row || row.attempt !== report.attempt || (row.state !== "assigned" && row.state !== "building")) return false;
  if (report.phase === "succeeded" && (row.image_digest === null || row.image_digest !== report.image_digest)) {
    console.warn(JSON.stringify({ event: "machine_build_report_refused", hostId, build_key: report.build_key,
      reason: row.image_digest === null ? "no result recorded" : "digest differs from the recorded result" }));
    return false;
  }
  const now = Date.now();
  const current = `build_key = ?1 AND host_id = ?2 AND attempt = ?3 AND state IN ('assigned', 'building')`;
  if (row.phase === report.phase) {
    await env.DB.prepare(`UPDATE machine_builds SET updated_at = ?4 WHERE ${current}`)
      .bind(report.build_key, hostId, report.attempt, now).run();
    return false;
  }
  const state = report.phase === "queued" ? "assigned"
    : report.phase === "succeeded" || report.phase === "failed" ? report.phase : "building";
  const error = report.phase === "failed" ? (report.error || "the builder reported no error").slice(0, MAX_BUILD_ERROR_CHARS) : null;
  // The failure outcome is decided on the row as written, so a result POST
  // racing this report is never lost.
  const failure = `CASE WHEN image_digest IS NOT NULL THEN 'succeeded' WHEN attempt < ${MAX_MACHINE_BUILD_ATTEMPTS}
    THEN 'queued' ELSE 'failed' END`;
  const moved = await env.DB.prepare(
    `UPDATE machine_builds SET state = CASE WHEN ?4 = 'failed' THEN ${failure} ELSE ?4 END,
        host_id = CASE WHEN ?4 = 'failed' AND ${failure} = 'queued' THEN NULL ELSE host_id END,
        phase = ?5, error = ?6, updated_at = ?7
      WHERE ${current} AND phase IS NOT ?5 AND (?5 <> 'succeeded' OR image_digest = ?8)
      RETURNING state`,
  ).bind(report.build_key, hostId, report.attempt, state, report.phase, error, now,
    report.image_digest ?? null).first<{ state: string }>();
  if (!moved) return false;
  if (moved.state === "succeeded" || moved.state === "failed") await settleScenarioRevisions(env, { buildKey: report.build_key });
  if (moved.state !== "assigned" && moved.state !== "building") await syncBuilderDesiredState(env, hostId, now);
  return true;
}

/**
 * Settles the building revisions of a rev, or those that need a build key.
 * One with a failed build fails. One whose every machine has its image gets
 * the digests in its document and the document's digest, and is ready, or
 * verified when a verified revision of its scenario has the same digest and
 * guest contract.
 */
export async function settleScenarioRevisions(env: Env, by: { rev: string } | { buildKey: string }): Promise<void> {
  const { results } = await ("rev" in by
    ? env.DB.prepare(`SELECT scenario_id, rev, doc_json FROM scenario_revisions WHERE state = 'building' AND rev = ?1`)
      .bind(by.rev)
    : env.DB.prepare(
        `SELECT scenario_id, rev, doc_json FROM scenario_revisions WHERE state = 'building'
          AND EXISTS (SELECT 1 FROM json_each(doc_json, '$.machines') machine
            WHERE json_extract(machine.value, '$.build_key') = ?1)`,
      ).bind(by.buildKey)
  ).all<{ scenario_id: string; rev: string; doc_json: string }>();
  for (const revision of results) {
    const doc = JSON.parse(revision.doc_json) as ScenarioRevisionV1;
    const keys = [...new Set(doc.machines.map((machine) => machine.build_key))];
    const { results: builds } = await env.DB.prepare(
      `SELECT build_key, state, image_digest FROM machine_builds
        WHERE build_key IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(keys)).all<{ build_key: string; state: string; image_digest: string | null }>();
    const byKey = new Map(builds.map((build) => [build.build_key, build]));
    if (keys.some((key) => byKey.get(key)?.state === "failed")) {
      await env.DB.prepare(
        `UPDATE scenario_revisions SET state = 'failed', failure_reason = ?3
          WHERE scenario_id = ?1 AND rev = ?2 AND state = 'building'`,
      ).bind(revision.scenario_id, revision.rev, REVISION_BUILD_FAILURE).run();
      continue;
    }
    if (!keys.every((key) => byKey.get(key)?.state === "succeeded" && byKey.get(key)?.image_digest)) continue;
    const ready = canonicalJson({
      ...doc,
      machines: doc.machines.map((machine) => ({ ...machine, image_digest: byKey.get(machine.build_key)!.image_digest })),
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE scenario_revisions SET doc_json = ?3, content_digest = ?4,
            state = CASE WHEN EXISTS (SELECT 1 FROM scenario_revisions twin WHERE twin.scenario_id = ?1
              AND twin.content_digest = ?4 AND twin.guest_contract = scenario_revisions.guest_contract
              AND twin.state = 'verified') THEN 'verified' ELSE 'ready' END
          WHERE scenario_id = ?1 AND rev = ?2 AND state = 'building'`,
      ).bind(revision.scenario_id, revision.rev, ready, await sha256Digest(ready)),
      selectCandidateRevision(env.DB, revision.scenario_id, revision.rev),
    ]);
  }
}

/**
 * Makes `rev` its scenario's candidate when it is ready or verified and the
 * scenario's head: no revision of the scenario was ingested after it. An
 * older revision that settles late, or one behind a newer building or failed
 * head, leaves the candidate as it is.
 */
export function selectCandidateRevision(d1: D1Database, scenarioId: string, rev: string): D1PreparedStatement {
  return d1.prepare(
    `UPDATE scenarios SET candidate_rev = ?2, updated_at = ?3
      WHERE id = ?1 AND candidate_rev IS NOT ?2
        AND EXISTS (SELECT 1 FROM scenario_revisions head WHERE head.scenario_id = ?1 AND head.rev = ?2
          AND head.state IN ('ready', 'verified')
          AND NOT EXISTS (SELECT 1 FROM scenario_revisions newer WHERE newer.scenario_id = ?1
            AND (newer.created_at > head.created_at OR (newer.created_at = head.created_at AND newer.rev > head.rev))))`,
  ).bind(scenarioId, rev, Date.now());
}
