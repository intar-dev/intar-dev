/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import { appError } from "@/lib/app-error";
import { settleScenarioRevisions } from "@/lib/machine-builds";
import { maintainPipelineRevisions } from "@/lib/pipeline-revisions";
import { ingestSourceBundle } from "@/lib/scenario-bundles";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { liftRevisionHold, moveLiveRevision } from "@/lib/scenario-revisions";
import {
  DEPLOY_JOB_DEADLINE_MS, DEPLOY_JOB_STORAGE_KEY, DEPLOY_JOB_VERIFY_LEASE_MS, detailOf, driveDeployJob, type DeployJob,
  type Lab,
} from "@/lib/source-deploy-job";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org-a";
const SCOPE = `organization:${ORG}`;
const OWNER = "owner";
const IMAGE = `sha256:${"1".repeat(64)}`;
const WEB = "acme/broken-nginx";
const DB_LAB = "acme/second-lab";

let digest: string;
let now: number;
let stored: Map<string, unknown>;
let begun: Array<{ scenarioId: string; rev: string; leaseMs: number }>;
/** Every run row made, so ids stay apart when a test empties `begun`. */
let runs: number;
let ended: string[];
/** The refusal the next starts get, by scenario; `*` for every one. */
let refuse: Record<string, string>;

const rev = (sha: string) => `git-42-${sha.repeat(40)}-${digest}`;
const storage = {
  get: async <T>(key: string) => stored.get(key) as T | undefined,
  put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
  delete: async (key: string) => stored.delete(key),
} as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete">;

const deps = {
  /** Starts a run as the real start would leave it: active under the revision's verify key. */
  async beginVerifyRun(input: { scenarioId: string; rev: string; leaseMs: number }) {
    const code = refuse[input.scenarioId] ?? refuse["*"];
    if (code) throw appError(409, code, code);
    begun.push(input);
    runs += 1;
    const runId = `run-${runs}`;
    await env.DB.prepare(`INSERT INTO scenario_runs
      (run_id, user_id, host_id, scenario_id, scenario_rev, scenario_name, title, tagline, briefing_markdown, objectives_json,
       difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, vm_count, state, state_rank, state_json,
       launch_source, active_key)
      VALUES (?1, ?2, 'host', ?3, ?4, 'Scenario', 'Title', '', '', '[]', 'beginner', 1, '[]', '[]', '', 0, 'provisioning', 1, '{}',
        'verify', ?5)`)
      .bind(runId, OWNER, input.scenarioId, input.rev, `verify:${SCOPE}:${input.rev}:${input.scenarioId}`).run();
    return { runId };
  },
  async endVerifyRun(runId: string) {
    ended.push(runId);
    await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL, delete_requested_at = 1, state = 'completed' WHERE run_id = ?1")
      .bind(runId).run();
  },
  moveLive: moveLiveRevision,
};

const drive = () => driveDeployJob({ db: env.DB, storage, scopeKey: SCOPE, digest, now, deps });
const job = () => stored.get(DEPLOY_JOB_STORAGE_KEY) as DeployJob | undefined;
const commit = (sha = "a") => env.DB.prepare(
  "SELECT state, detail FROM scenario_source_commits WHERE scope_key = ?1 AND rev = ?2",
).bind(SCOPE, rev(sha)).first<{ state: string; detail: string | null }>();
const scenario = (scenarioId: string) => env.DB.prepare("SELECT live_rev, enabled FROM scenarios WHERE id = ?1")
  .bind(scenarioId).first<{ live_rev: string | null; enabled: number }>();
const sourceRow = () => env.DB.prepare("SELECT live_rev, live_sha, live_at FROM scenario_sources WHERE scope_key = ?1")
  .bind(SCOPE).first<{ live_rev: string | null; live_sha: string | null; live_at: number | null }>();
const catalogRev = () => env.DB.prepare("SELECT source_revision FROM course_catalogs WHERE scope_key = ?1")
  .bind(SCOPE).first<string>("source_revision");
const revisionState = (scenarioId: string, sha = "a") => env.DB.prepare(
  "SELECT state FROM scenario_revisions WHERE scenario_id = ?1 AND rev = ?2",
).bind(scenarioId, rev(sha)).first<string>("state");

/** A bundle of two labs; `words` makes the second another lab than before. */
function twoLabs(words = "") {
  const bundle = structuredClone(bundleFixture);
  const second = structuredClone(bundle.scenarios[0]!);
  second.slug = "second-lab";
  second.summary = `${second.summary} ${words}`;
  // A machine of its own, so its image is built apart from the first lab's.
  second.machines[0]!.setup[0]!.script += "\n# the second lab's own";
  bundle.scenarios.push(second);
  return bundle;
}

/** The head moves to `sha`, whose bundle is ingested and whose deploy row is `building`. */
async function head(sha: string, bundle: typeof bundleFixture = bundleFixture, built = true) {
  const refused = await ingestSourceBundle(env, {
    organizationId: ORG, rev: rev(sha), gzip: new Uint8Array(gzipSync(JSON.stringify(bundle))), stored: false,
  });
  expect(refused).toBeNull();
  await env.DB.batch([
    env.DB.prepare("UPDATE scenario_sources SET head_sha = ?2 WHERE scope_key = ?1").bind(SCOPE, sha.repeat(40)),
    env.DB.prepare(`INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, attempt, state)
      VALUES (?1, ?2, 'deploy', ?3, ?4, 'push', 1, 'building')`).bind(`row-${sha}`, SCOPE, sha.repeat(40), rev(sha)),
  ]);
  if (built) await build(sha);
}

/** The builds of `sha` succeed, so its revisions leave `building`. */
async function build(sha: string) {
  await env.DB.prepare("UPDATE machine_builds SET state = 'succeeded', image_digest = ?1 WHERE image_digest IS NULL").bind(IMAGE).run();
  await settleScenarioRevisions(env, { rev: rev(sha) });
}

/** A run of the job ends with `outcome`; `reported` says whether its lab said anything. */
async function finish(runId: string, outcome: "passed" | "failed" | "verify_timeout" | "gone", reported = true) {
  const run = await env.DB.prepare("SELECT scenario_id, scenario_rev FROM scenario_runs WHERE run_id = ?1")
    .bind(runId).first<{ scenario_id: string; scenario_rev: string }>();
  await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL, state = 'completed' WHERE run_id = ?1").bind(runId).run();
  if (outcome === "gone") return;
  const report = { runId, outcome, at: now, machines: [{ name: "webserver", verify: reported ? { done: false } : null, failure: null }] };
  await env.DB.prepare(
    `UPDATE scenario_revisions SET verify_run_id = ?3, verify_report_json = ?4,
        state = CASE WHEN ?5 = 'passed' THEN 'verified' ELSE state END WHERE scenario_id = ?1 AND rev = ?2`,
  ).bind(run!.scenario_id, run!.scenario_rev, runId, JSON.stringify(report), outcome).run();
}

beforeAll(async () => {
  digest = await sourceCompileDigest();
});

beforeEach(async () => {
  await resetD1Database();
  now = Date.now();
  stored = new Map();
  begun = [];
  runs = 0;
  ended = [];
  refuse = {};
  await createFixtureMember({ d1: env.DB, userId: OWNER });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?1, 'Acme', 'acme', 1)").bind(ORG),
    env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m', ?1, ?2, 'owner', 1)").bind(ORG, OWNER),
    env.DB.prepare(`INSERT INTO scenario_sources (scope_key, organization_id, github_installation_id, github_repository_id,
        github_repository, default_branch, mode, bound_by_user_id, promotion)
      VALUES (?1, ?2, 7, 42, 'acme/labs', 'main', 'push', ?3, 'automatic')`).bind(SCOPE, ORG, OWNER),
    env.DB.prepare("INSERT INTO agent_hosts (id, user_id, name, scope, credential_generation) VALUES ('host', ?1, 'Server', 'platform', 1)").bind(OWNER),
    env.DB.prepare("INSERT INTO registry_manifests (digest, media_type, artifact_type, size) VALUES (?1, 'm', 'a', 1)").bind(IMAGE),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an automatic source's job", () => {
  it("does nothing for a manual source, and gives a waiting row back", async () => {
    await env.DB.prepare("UPDATE scenario_sources SET promotion = 'manual' WHERE scope_key = ?1").bind(SCOPE).run();
    await head("a");
    expect(await drive()).toEqual({ wait: false });
    expect(begun).toEqual([]);
    expect(await commit()).toMatchObject({ state: "building" });
    expect(job()).toBeUndefined();
    // Switched to manual while its job ran: the runs end, the row shows as before.
    await env.DB.prepare("UPDATE scenario_sources SET promotion = 'automatic' WHERE scope_key = ?1").bind(SCOPE).run();
    await drive();
    expect(await commit()).toMatchObject({ state: "waiting" });
    await env.DB.prepare("UPDATE scenario_sources SET promotion = 'manual' WHERE scope_key = ?1").bind(SCOPE).run();
    await drive();
    expect(ended).toEqual(["run-1"]);
    expect(job()).toBeUndefined();
    expect(await commit()).toEqual({ state: "building", detail: null });
  });

  it("waits for the images, then starts a verify run with the short lease, once", async () => {
    await head("a", bundleFixture, false);
    await drive();
    expect(await commit()).toMatchObject({ state: "building" });
    expect(begun).toEqual([]);
    await build("a");
    expect(await drive()).toEqual({ wait: false });
    expect(begun).toEqual([{ scenarioId: WEB, rev: rev("a"), leaseMs: DEPLOY_JOB_VERIFY_LEASE_MS }]);
    expect(await commit()).toEqual({ state: "waiting", detail: null });
    expect(job()).toMatchObject({ rowId: "row-a", attempt: 1, decided: 0, total: 1, labs: { [WEB]: { runs: [{ id: "run-1" }] } } });
    // The run goes on: nothing more is started.
    await drive();
    expect(begun).toHaveLength(1);
    // The commit's catalog is the scope's by now; the lab is not live yet.
    expect(await catalogRev()).toBe(rev("a"));
    expect(await scenario(WEB)).toEqual({ live_rev: null, enabled: 1 });
    expect(await sourceRow()).toEqual({ live_rev: null, live_sha: null, live_at: null });
    // It passes: the lab goes live, and with it the commit.
    await finish("run-1", "passed");
    await drive();
    expect(begun).toHaveLength(1);
    expect(await scenario(WEB)).toEqual({ live_rev: rev("a"), enabled: 1 });
    expect(await commit()).toEqual({ state: "live", detail: `- ${WEB}: live` });
    expect(await sourceRow()).toMatchObject({ live_rev: rev("a"), live_sha: "a".repeat(40) });
    expect((await sourceRow())!.live_at).not.toBeNull();
    expect(job()).toBeUndefined();
    // Nothing is left to drive.
    expect(await drive()).toEqual({ wait: false });
    expect(await commit()).toMatchObject({ state: "live" });
  });

  it("fails a lab after two failed runs, counting each run once", async () => {
    await head("a");
    await drive();
    await finish("run-1", "failed");
    // The next start is refused for a while: the one failure stays one.
    refuse = { "*": "verify_quota_exhausted" };
    expect(await drive()).toEqual({ wait: true });
    expect(await drive()).toEqual({ wait: true });
    expect(await commit()).toEqual({ state: "waiting", detail: `- ${WEB}: waiting for a free verify slot` });
    refuse = {};
    await drive();
    expect(begun).toHaveLength(2);
    await finish("run-2", "failed");
    await drive();
    expect(begun).toHaveLength(2);
    expect(await commit()).toEqual({ state: "failed", detail: `- ${WEB}: its checks did not pass in 2 verify runs` });
    expect(job()).toBeUndefined();
  });

  it("fails a lab whose run timed out after it reported, and only counts a start for one that never did", async () => {
    await head("a");
    await drive();
    await finish("run-1", "verify_timeout", false);
    await drive();
    expect(begun).toHaveLength(2);
    await finish("run-2", "gone");
    await drive();
    expect(begun).toHaveLength(3);
    expect(await commit()).toMatchObject({ state: "waiting" });
    // The third start that comes to nothing is the last.
    await finish("run-3", "verify_timeout", false);
    await drive();
    expect(begun).toHaveLength(3);
    expect(await commit()).toEqual({ state: "failed", detail: `- ${WEB}: its verify run did not finish` });

    await env.DB.prepare("UPDATE scenario_sources SET head_sha = NULL WHERE scope_key = ?1").bind(SCOPE).run();
    await head("b", twoLabs());
    refuse = { [DB_LAB]: "scenario_image_preparing" };
    await drive();
    const run = `run-${begun.length}`;
    await finish(run, "verify_timeout", true);
    await drive();
    expect((await commit("b"))!.detail).toContain(`- ${WEB}: its verify run did not finish`);
  });

  it("decides every lab by itself: one fails, the other goes on, and the row fails only at the end", async () => {
    await head("a", twoLabs());
    refuse = { [DB_LAB]: "scenario_image_preparing" };
    expect(await drive()).toEqual({ wait: true });
    expect(begun.map((run) => run.scenarioId)).toEqual([WEB]);
    expect(await commit()).toEqual({ state: "waiting", detail: `- ${DB_LAB}: waiting for a platform host to fetch its images` });
    // The first lab's revision fails outright.
    await finish("run-1", "gone");
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'failed', failure_reason = 'its build failed' WHERE scenario_id = ?1")
      .bind(WEB).run();
    refuse = {};
    await drive();
    expect(await commit()).toMatchObject({ state: "waiting" });
    expect(begun.map((run) => run.scenarioId)).toEqual([WEB, DB_LAB]);
    expect(job()).toMatchObject({ decided: 1, total: 2 });
    await finish("run-2", "passed");
    await drive();
    // The lab that passed is live although the commit failed.
    expect(await scenario(DB_LAB)).toMatchObject({ live_rev: rev("a") });
    expect(await scenario(WEB)).toMatchObject({ live_rev: null });
    expect(await commit()).toEqual({ state: "failed", detail: `- ${WEB}: its build failed\n- ${DB_LAB}: live` });
    expect(await sourceRow()).toMatchObject({ live_rev: rev("a") });
  });

  it("stops starting for the pass at a refusal of the whole scope", async () => {
    await head("a", twoLabs());
    refuse = { "*": "scenario_host_unavailable" };
    let asked = 0;
    const counting = { ...deps, beginVerifyRun: async (input: Parameters<typeof deps.beginVerifyRun>[0]) => {
      asked += 1;
      return deps.beginVerifyRun(input);
    } };
    expect(await driveDeployJob({ db: env.DB, storage, scopeKey: SCOPE, digest, now, deps: counting })).toEqual({ wait: true });
    expect(asked).toBe(1);
    expect(await commit()).toEqual({
      state: "waiting",
      detail: `- ${WEB}: waiting for a platform host\n- ${DB_LAB}: waiting for a platform host`,
    });
  });

  /** Rev `sha` goes live through the job, every lab verified without a run of its own. */
  async function live(sha: string, bundle: typeof bundleFixture) {
    await head(sha, bundle);
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = ?1 AND state = 'ready'").bind(rev(sha)).run();
    await drive();
    expect((await commit(sha))!.state).toBe("live");
  }

  it("moves only the labs a commit changed, and says so", async () => {
    await live("a", twoLabs());
    expect(await commit()).toEqual({
      state: "live", detail: `- ${WEB}: live, verified without a run\n- ${DB_LAB}: live, verified without a run`,
    });
    // Rev b changes only the second lab, and only its words: verified by inheritance.
    await head("b", twoLabs("changed"));
    await drive();
    expect(begun).toEqual([]);
    expect(await scenario(WEB)).toMatchObject({ live_rev: rev("a") });
    expect(await scenario(DB_LAB)).toMatchObject({ live_rev: rev("b") });
    expect(await commit("b")).toEqual({
      state: "live", detail: `- ${DB_LAB}: live, verified without a run\n- 1 lab unchanged`,
    });
    expect(await catalogRev()).toBe(rev("b"));
    expect(await sourceRow()).toMatchObject({ live_rev: rev("b"), live_sha: "b".repeat(40) });
  });

  it("leaves a held lab where it is while the commit goes live, and takes it up again on the lift", async () => {
    await live("a", twoLabs());
    await head("b", twoLabs("changed"));
    await env.DB.prepare(`INSERT INTO scenario_revision_holds (scenario_id, behaviour_digest, held_at)
      SELECT scenario_id, behaviour_digest, 1 FROM scenario_revisions WHERE scenario_id = ?1 AND rev = ?2`).bind(DB_LAB, rev("b")).run();
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = ?1 AND state = 'ready'").bind(rev("b")).run();
    await drive();
    expect(await scenario(DB_LAB)).toMatchObject({ live_rev: rev("a") });
    expect(await commit("b")).toEqual({
      state: "live", detail: `- ${DB_LAB}: held; an administrator must lift it\n- 1 lab unchanged`,
    });
    // The lift takes the commit up again as a new attempt.
    await liftRevisionHold({ scenarioId: DB_LAB, rev: rev("b"), actorUserId: OWNER });
    expect(await env.DB.prepare("SELECT state, attempt, detail FROM scenario_source_commits WHERE id = 'row-b'").first())
      .toEqual({ state: "waiting", attempt: 2, detail: null });
    await drive();
    expect(await scenario(DB_LAB)).toMatchObject({ live_rev: rev("b") });
    expect((await commit("b"))!.state).toBe("live");
    // A row that ended before its ingest has no bundle, and is not taken up.
    await env.DB.prepare(`INSERT INTO scenario_revision_holds (scenario_id, behaviour_digest, held_at)
      SELECT scenario_id, behaviour_digest, 1 FROM scenario_revisions WHERE scenario_id = ?1 AND rev = ?2
      ON CONFLICT DO UPDATE SET lifted_at = NULL`).bind(DB_LAB, rev("b")).run();
    await env.DB.batch([
      env.DB.prepare("UPDATE scenario_sources SET head_sha = ?2 WHERE scope_key = ?1").bind(SCOPE, "c".repeat(40)),
      env.DB.prepare(`INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, attempt, state, detail)
        VALUES ('row-c', ?1, 'deploy', ?2, ?3, 'push', 1, 'failed', 'the fetch failed')`).bind(SCOPE, "c".repeat(40), rev("c")),
    ]);
    await liftRevisionHold({ scenarioId: DB_LAB, rev: rev("b"), actorUserId: OWNER });
    expect(await commit("c")).toEqual({ state: "failed", detail: "the fetch failed" });
  });

  it("disables a lab the commit no longer has and enables one it has again, which is then checked and moved", async () => {
    await live("a", twoLabs());
    // Rev b has only the first lab.
    await head("b");
    await drive();
    expect(await scenario(DB_LAB)).toEqual({ live_rev: rev("a"), enabled: 0 });
    expect(await scenario(WEB)).toMatchObject({ enabled: 1 });
    expect(await commit("b")).toEqual({ state: "live", detail: "- 1 lab unchanged" });
    // Rev c has the second lab again, changed.
    await head("c", twoLabs("back"));
    expect(await drive()).toEqual({ wait: true });
    expect(await scenario(DB_LAB)).toMatchObject({ enabled: 1, live_rev: rev("a") });
    expect((await commit("c"))!.state).toBe("waiting");
    await drive();
    expect(await scenario(DB_LAB)).toMatchObject({ live_rev: rev("c") });
    expect((await commit("c"))!.state).toBe("live");
  });

  it("holds the commit's step while a run uses a lab it removes, and fails the commit at the deadline", async () => {
    await live("a", twoLabs());
    await env.DB.prepare(`INSERT INTO scenario_runs
      (run_id, user_id, host_id, scenario_id, scenario_rev, scenario_name, title, tagline, briefing_markdown, objectives_json,
       difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, vm_count, state, state_rank, state_json)
      VALUES ('learner-run', ?1, 'host', ?2, ?3, 'Scenario', 'Title', '', '', '[]', 'beginner', 1, '[]', '[]', '', 0, 'ready', 1, '{}')`)
      .bind(OWNER, DB_LAB, rev("a")).run();
    await head("b");
    expect(await drive()).toEqual({ wait: true });
    expect(await scenario(DB_LAB)).toMatchObject({ enabled: 1 });
    expect(await catalogRev()).toBe(rev("a"));
    expect(await commit("b")).toEqual({
      state: "awaiting_promote",
      detail: "- the course catalog waits for an idle moment: a run still uses what the commit removes\n- 1 lab unchanged",
    });
    expect(await sourceRow()).toMatchObject({ live_rev: rev("a") });
    // The run ends: the step goes through and the commit is live.
    await env.DB.prepare("UPDATE scenario_runs SET state = 'completed' WHERE run_id = 'learner-run'").run();
    await drive();
    expect(await scenario(DB_LAB)).toMatchObject({ enabled: 0 });
    expect(await catalogRev()).toBe(rev("b"));
    expect((await commit("b"))!.state).toBe("live");

    // Held to the deadline, the commit fails; nothing is taken from the run.
    await env.DB.prepare("UPDATE scenario_runs SET state = 'ready', scenario_id = ?1 WHERE run_id = 'learner-run'").bind(WEB).run();
    const none = structuredClone(twoLabs());
    none.scenarios.shift();
    none.course_catalog.courses[0]!.lectures = none.course_catalog.courses[0]!.lectures
      .filter((lecture) => !("scenario_id" in lecture) || lecture.scenario_id !== "broken-nginx");
    await head("c", none);
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = ?1 AND state = 'ready'").bind(rev("c")).run();
    await drive();
    expect((await commit("c"))!.state).toBe("awaiting_promote");
    // The lab the commit has again stays disabled until the step goes through.
    expect(await scenario(DB_LAB)).toMatchObject({ enabled: 0 });
    now += DEPLOY_JOB_DEADLINE_MS;
    await drive();
    const failed = await commit("c");
    expect(failed!.state).toBe("failed");
    expect(failed!.detail).toContain("the course catalog was not published");
    expect(await scenario(WEB)).toMatchObject({ enabled: 1 });
  });

  it("waits for a move that is refused, and fails the lab when it is refused for a day", async () => {
    await head("a");
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = ?1").bind(rev("a")).run();
    const busy = { ...deps, moveLive: async () => { throw appError(503, "registry_busy", "busy"); } };
    const driveBusy = () => driveDeployJob({ db: env.DB, storage, scopeKey: SCOPE, digest, now, deps: busy });
    expect(await driveBusy()).toEqual({ wait: true });
    expect(await commit()).toEqual({ state: "waiting", detail: `- ${WEB}: waiting for the image registry` });
    now += DEPLOY_JOB_DEADLINE_MS;
    await driveBusy();
    expect(await commit()).toEqual({ state: "failed", detail: `- ${WEB}: it could not go live within 24 hours` });
    expect(await scenario(WEB)).toMatchObject({ live_rev: null });
  });

  it("stops the commit's step at the binder's rights, in the step's own statement", async () => {
    await head("a");
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("UPDATE member SET role = 'member'").run();
      return batch(statements);
    });
    await drive();
    expect(await catalogRev()).toBeNull();
    vi.restoreAllMocks();
  });

  it("lists the failed labs first and cuts the lines at a whole one", () => {
    const labs = new Map<string, Lab>();
    for (let index = 0; index < 100; index += 1) {
      labs.set(`acme/lab-${String(index).padStart(3, "0")}`, index % 2
        ? { kind: "live", inherited: false } : { kind: "failed", note: `its build failed ${"x".repeat(60)}` });
    }
    labs.set("acme/same", { kind: "unchanged" });
    const lines = detailOf(labs, "- the step")!.split("\n");
    expect(lines.join("\n").length).toBeLessThanOrEqual(4096);
    expect(lines[0]).toBe("- the step");
    expect(lines[1]).toContain("acme/lab-000: its build failed");
    expect(lines.at(-1)).toBe("- 1 lab unchanged");
    const shown = lines.length - 3;
    expect(lines.at(-2)).toBe(`- and ${100 - shown} more`);
    expect(detailOf(new Map(), null)).toBeNull();
  });

  it("fails a commit without labs and disables nothing", async () => {
    await live("a", twoLabs());
    await env.DB.batch([
      env.DB.prepare("UPDATE scenario_sources SET head_sha = ?2 WHERE scope_key = ?1").bind(SCOPE, "b".repeat(40)),
      env.DB.prepare(`INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, attempt, state)
        VALUES ('row-b', ?1, 'deploy', ?2, ?3, 'push', 1, 'building')`).bind(SCOPE, "b".repeat(40), rev("b")),
    ]);
    await drive();
    expect(await commit("b")).toEqual({ state: "failed", detail: "the commit has no labs" });
    expect(await scenario(WEB)).toMatchObject({ enabled: 1 });
    expect(await sourceRow()).toMatchObject({ live_rev: rev("a") });
  });

  it("changes nothing for a head an older bundle made: its labs are not the candidates", async () => {
    await live("a", twoLabs());
    await live("b", twoLabs("changed"));
    // Back to rev a's sha, as after a force-push.
    await env.DB.batch([
      env.DB.prepare("UPDATE scenario_sources SET head_sha = ?2 WHERE scope_key = ?1").bind(SCOPE, "a".repeat(40)),
      env.DB.prepare("UPDATE scenario_source_commits SET state = 'building', attempt = 2 WHERE id = 'row-a'"),
    ]);
    await drive();
    expect(await catalogRev()).toBe(rev("b"));
    expect(await scenario(DB_LAB)).toEqual({ live_rev: rev("b"), enabled: 1 });
    expect(await commit("a")).toEqual({
      state: "failed",
      detail: `- ${DB_LAB}: a newer revision of this lab exists; publish the commit again\n- ${WEB}: live, verified without a run`,
    });
  });

  it("moves nothing once the source may not act: paused, manual, another binder, or a head that moved", async () => {
    await head("a");
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = ?1").bind(rev("a")).run();
    const source = { scopeKey: SCOPE, rowId: "row-a", attempt: 1, digest };
    const moveA = () => moveLiveRevision({ scenarioId: WEB, rev: rev("a"), liveRev: null, kind: "promote", actorUserId: OWNER, source });
    const refused = async (sql: string, undo: string) => {
      await env.DB.prepare(sql).run();
      await expect(moveA()).rejects.toMatchObject({ status: 404 });
      expect(await scenario(WEB)).toMatchObject({ live_rev: null });
      await env.DB.prepare(undo).run();
    };
    await refused("UPDATE scenario_sources SET paused_at = 1", "UPDATE scenario_sources SET paused_at = NULL");
    await refused("UPDATE scenario_sources SET promotion = 'manual'", "UPDATE scenario_sources SET promotion = 'automatic'");
    await refused("UPDATE scenario_sources SET disconnected_at = 1", "UPDATE scenario_sources SET disconnected_at = NULL");
    await refused(`UPDATE scenario_sources SET head_sha = '${"f".repeat(40)}'`, `UPDATE scenario_sources SET head_sha = '${"a".repeat(40)}'`);
    await refused("UPDATE scenario_source_commits SET attempt = 2", "UPDATE scenario_source_commits SET attempt = 1");
    await refused("UPDATE scenario_source_commits SET state = 'superseded'", "UPDATE scenario_source_commits SET state = 'building'");
    await refused("UPDATE member SET role = 'member'", "UPDATE member SET role = 'owner'");
    // Another binder than the one the job read.
    await expect(moveLiveRevision({ scenarioId: WEB, rev: rev("a"), liveRev: null, kind: "promote", actorUserId: "someone", source }))
      .rejects.toMatchObject({ status: 404 });
    // Lost between the read and the write: the move's own statement refuses.
    for (const sql of ["UPDATE scenario_sources SET paused_at = 1", "UPDATE member SET role = 'member'",
      "UPDATE scenario_source_commits SET attempt = 2"]) {
      const batch = env.DB.batch.bind(env.DB);
      const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        await env.DB.prepare(sql).run();
        return batch(statements);
      });
      await expect(moveA()).rejects.toMatchObject({ code: "live_revision_changed" });
      expect(await scenario(WEB)).toMatchObject({ live_rev: null });
      spy.mockRestore();
      await env.DB.batch([
        env.DB.prepare("UPDATE scenario_sources SET paused_at = NULL"), env.DB.prepare("UPDATE member SET role = 'owner'"),
        env.DB.prepare("UPDATE scenario_source_commits SET attempt = 1"),
      ]);
    }
    // A rollback is never the job's, and the move goes through once all holds.
    await expect(moveLiveRevision({ scenarioId: WEB, rev: rev("a"), liveRev: null, kind: "rollback", actorUserId: OWNER, source }))
      .rejects.toThrow();
    // The catalog is not this path's.
    await moveA();
    expect(await scenario(WEB)).toMatchObject({ live_rev: rev("a") });
    expect(await catalogRev()).toBeNull();
  });

  it("ends its runs when the head moves, and starts over for the new head", async () => {
    await head("a");
    await drive();
    expect(job()).toMatchObject({ rowId: "row-a" });
    await head("b");
    await drive();
    expect(ended).toEqual(["run-1"]);
    expect(job()).toMatchObject({ rowId: "row-b", labs: { [WEB]: { runs: [{ id: "run-2" }] } } });
    // A re-run of the same row is another attempt: its counts start afresh.
    await finish("run-2", "failed");
    await env.DB.prepare("UPDATE scenario_source_commits SET attempt = 2 WHERE id = 'row-b'").run();
    await drive();
    expect(job()).toMatchObject({ rowId: "row-b", attempt: 2, labs: { [WEB]: { runs: [{ id: "run-3" }] } } });
    // A run that has ended by itself is not ended again.
    expect(ended).toEqual(["run-1"]);
  });

  it("starts nothing once the binding may not write, and leaves an administrator's run alone", async () => {
    await head("a");
    // An administrator's verify run of the same revision.
    refuse = {};
    await deps.beginVerifyRun({ scenarioId: WEB, rev: rev("a"), leaseMs: 1 });
    begun = [];
    await drive();
    expect(begun).toEqual([]);
    expect(job()).toMatchObject({ labs: {} });
    await finish("run-1", "failed");
    // Its failure is not the job's: the job has two failures of its own to go.
    await env.DB.prepare("UPDATE member SET role = 'member' WHERE user_id = ?1").bind(OWNER).run();
    await drive();
    expect(begun).toEqual([]);
    await env.DB.prepare("UPDATE member SET role = 'owner' WHERE user_id = ?1").bind(OWNER).run();
    await drive();
    expect(job()!.labs[WEB]!.runs).toEqual([{ id: "run-2" }]);
    await finish("run-2", "failed");
    await drive();
    expect(await commit()).toMatchObject({ state: "waiting" });
    expect(job()!.labs[WEB]!.runs).toEqual([{ id: "run-2", outcome: "failed" }, { id: "run-3" }]);
  });

  it("keeps its own run's failure when an administrator's run follows before the next pass", async () => {
    await head("a");
    await drive();
    await finish("run-1", "failed");
    // An administrator's run starts and fails before the job looks again.
    await deps.beginVerifyRun({ scenarioId: WEB, rev: rev("a"), leaseMs: 1 });
    await drive();
    expect(job()!.labs[WEB]!.runs).toEqual([{ id: "run-1", outcome: "failed" }]);
    await finish("run-2", "failed");
    await drive();
    await finish("run-3", "failed");
    await drive();
    expect(await commit()).toEqual({ state: "failed", detail: `- ${WEB}: its checks did not pass in 2 verify runs` });
  });

  it("looks again in a minute while a recorded run still holds its slot", async () => {
    await head("a");
    await drive();
    // The lease ended: the report is written, the slot not yet free.
    const report = { runId: "run-1", outcome: "verify_timeout", at: now, machines: [{ name: "webserver", verify: null, failure: null }] };
    await env.DB.prepare("UPDATE scenario_revisions SET verify_run_id = 'run-1', verify_report_json = ?1 WHERE rev = ?2")
      .bind(JSON.stringify(report), rev("a")).run();
    expect(await drive()).toEqual({ wait: true });
    expect(begun).toHaveLength(1);
    await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL WHERE run_id = 'run-1'").run();
    expect(await drive()).toEqual({ wait: false });
    expect(begun).toHaveLength(2);
  });

  it("gives a manual source its row back as failed when a revision of it failed", async () => {
    await head("a");
    await drive();
    await finish("run-1", "gone");
    await env.DB.batch([
      env.DB.prepare("UPDATE scenario_revisions SET state = 'failed', failure_reason = 'x' WHERE rev = ?1").bind(rev("a")),
      env.DB.prepare("UPDATE scenario_sources SET promotion = 'manual' WHERE scope_key = ?1").bind(SCOPE),
    ]);
    await drive();
    expect(await commit()).toEqual({ state: "failed", detail: "a revision of this commit failed" });
    // A building row without a failed revision is left as it is.
    await head("b");
    await drive();
    expect(await commit("b")).toEqual({ state: "building", detail: null });
  });

  it("fails what is still undecided 24 hours after the job began, not after the revision was made", async () => {
    await head("a", twoLabs(), false);
    // Old revisions: a re-run long after ingest gets its full day.
    await env.DB.prepare("UPDATE scenario_revisions SET created_at = 1").run();
    await drive();
    expect(await commit()).toMatchObject({ state: "building" });
    await env.DB.prepare("UPDATE machine_builds SET state = 'succeeded', image_digest = ?1 WHERE build_key IN (SELECT json_extract(machine.value, '$.build_key') FROM scenario_revisions revision, json_each(revision.doc_json, '$.machines') machine WHERE revision.scenario_id = ?2)")
      .bind(IMAGE, WEB).run();
    await settleScenarioRevisions(env, { rev: rev("a") });
    refuse = { "*": "scenario_host_unavailable" };
    now += DEPLOY_JOB_DEADLINE_MS - 1;
    await drive();
    expect(await commit()).toMatchObject({ state: "building" });
    now += 1;
    await drive();
    const failed = await commit();
    expect(failed!.state).toBe("failed");
    expect(failed!.detail).toContain("the host check could not start within 24 hours");
    expect(failed!.detail).toContain("its images did not arrive within 24 hours");
  });

  it("fails a lab whose run is still going on at the deadline, and ends that run", async () => {
    await head("a");
    await drive();
    now += DEPLOY_JOB_DEADLINE_MS;
    await drive();
    expect(await commit()).toEqual({ state: "failed", detail: `- ${WEB}: its verify run did not finish` });
    expect(ended).toEqual(["run-1"]);
    expect(job()).toBeUndefined();
  });

  it("is the only writer of failed for its row: the pipeline deadline leaves the row to it", async () => {
    await env.DB.prepare("UPDATE scenario_sources SET image_producer = 'pipeline' WHERE scope_key = ?1").bind(SCOPE).run();
    const refused = await ingestSourceBundle(env, {
      organizationId: ORG, rev: rev("a"), gzip: new Uint8Array(gzipSync(JSON.stringify(bundleFixture))), stored: false,
      imageProducer: "pipeline", pipelineCanPush: true,
    });
    expect(refused).toBeNull();
    await env.DB.batch([
      env.DB.prepare("UPDATE scenario_sources SET head_sha = ?2 WHERE scope_key = ?1").bind(SCOPE, "a".repeat(40)),
      env.DB.prepare(`INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, attempt, state)
        VALUES ('row-a', ?1, 'deploy', ?2, ?3, 'push', 1, 'building')`).bind(SCOPE, "a".repeat(40), rev("a")),
    ]);
    await maintainPipelineRevisions(env, SCOPE, now + DEPLOY_JOB_DEADLINE_MS + 60_000);
    expect(await revisionState(WEB)).toBe("failed");
    expect(await commit()).toMatchObject({ state: "building" });
    await drive();
    expect((await commit())!.state).toBe("failed");
    // A manual source's row is failed by the deadline itself, as before.
    await env.DB.batch([
      env.DB.prepare("UPDATE scenario_sources SET promotion = 'manual' WHERE scope_key = ?1").bind(SCOPE),
      env.DB.prepare("UPDATE scenario_source_commits SET state = 'building' WHERE id = 'row-a'"),
      env.DB.prepare("UPDATE scenario_revisions SET state = 'building', created_at = 1 WHERE rev = ?1").bind(rev("a")),
    ]);
    await maintainPipelineRevisions(env, SCOPE, now + DEPLOY_JOB_DEADLINE_MS + 60_000);
    expect(await commit()).toMatchObject({ state: "failed" });
  });
});

describe("pokes", () => {
  const poked = () => env.DB.prepare("SELECT poked_at FROM scenario_sources WHERE scope_key = ?1").bind(SCOPE).first<number | null>("poked_at");
  const unpoke = () => env.DB.prepare("UPDATE scenario_sources SET poked_at = NULL WHERE scope_key = ?1").bind(SCOPE).run();

  it("reach an automatic source when a revision leaves building and when a hold is lifted, and never a manual one", async () => {
    await head("a", bundleFixture, false);
    await unpoke();
    await build("a");
    expect(await poked()).not.toBeNull();

    await env.DB.prepare(`INSERT INTO scenario_revision_holds (scenario_id, behaviour_digest, held_at)
      SELECT scenario_id, behaviour_digest, 1 FROM scenario_revisions WHERE scenario_id = ?1`).bind(WEB).run();
    await unpoke();
    await liftRevisionHold({ scenarioId: WEB, rev: rev("a"), actorUserId: OWNER });
    expect(await poked()).not.toBeNull();

    await env.DB.prepare("UPDATE scenario_sources SET promotion = 'manual', poked_at = NULL WHERE scope_key = ?1").bind(SCOPE).run();
    await head("b", bundleFixture, false);
    await unpoke();
    await build("b");
    expect(await poked()).toBeNull();
  });
});
