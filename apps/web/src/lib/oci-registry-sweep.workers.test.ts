/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blob } from "@/control-plane/image-registry/oci-test-fixtures";
import { revisionDoc, specBlob, store } from "@/lib/scenario-runs/revision-test-fixtures";
import { admitInternalRegistryOperation, setRegistryEnforcement } from "@/lib/image-registry-admission";
import { MaintenanceState } from "@/maintenance-state";
import { resetD1Database } from "@/test/d1-migrations";
import {
  OCI_SWEEP_AGE_GUARD_MS,
  readKinoPins,
  runOciSweep,
  type OciSweepEnv,
  type OciSweepOptions,
} from "./oci-registry-sweep";
import { runCleanup, type CleanupEnv } from "../../workers/image-registry-cleanup/src/cleanup";

const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
/** A sweep clock two days ahead, so every object stored by a test is past the age guard. */
const later = () => Date.now() + 2 * OCI_SWEEP_AGE_GUARD_MS;
const USER = "sweep-user";
const HOST = "sweep-host";

let n = 0;
async function image(label = `image-${n++}`) {
  return store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json",
    { guest_contract: 3, label }, [["application/vnd.intar.kernel.v1", `kernel ${label}`], ["application/vnd.intar.disk.chunk.v1+zstd", `chunk ${label}`]]);
}

async function kino(label = `kino-${n++}`) {
  return store("application/vnd.intar.kino.v1", "application/vnd.intar.kino.config.v1+json", { guest_contract: 3, label },
    [["application/octet-stream", `kino ${label}`]]);
}

/** The keys of a manifest and every blob its index names. */
async function closure(manifest: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT blob_digest FROM registry_manifest_blobs WHERE manifest_digest = ?1")
    .bind(manifest).all<{ blob_digest: string }>();
  return [manifest, ...results.map((row) => row.blob_digest)].map(key);
}

const key = (digest: string) => `oci/sha256/${digest.slice("sha256:".length)}`;
const present = async (keys: string[]) => (await Promise.all(keys.map((k) => bucket.head(k)))).every(Boolean);
const absent = async (keys: string[]) => (await Promise.all(keys.map((k) => bucket.head(k)))).every((object) => object === null);

async function seedHost() {
  await env.DB.prepare("INSERT OR IGNORE INTO user (id, name, email) VALUES (?1, ?1, ?1 || '@example.test')").bind(USER).run();
  await env.DB.prepare("INSERT OR IGNORE INTO agent_hosts (id, user_id, name, scope, credential_generation) VALUES (?1, ?2, ?1, 'platform', 1)")
    .bind(HOST, USER).run();
}

async function seedScenario(id: string, pointers: { live?: string; candidate?: string } = {}) {
  const [namespace, slug] = id.split("/");
  await env.DB.prepare(`INSERT INTO scenarios (id, namespace, slug, scope_key, enabled, play, live_rev, candidate_rev)
    VALUES (?1, ?2, ?3, 'public', 1, 0, ?4, ?5)`).bind(id, namespace, slug, pointers.live ?? null, pointers.candidate ?? null).run();
}

async function seedRevision(scenarioId: string, rev: string, state: string, doc: unknown, createdAt = Date.now()) {
  await env.DB.prepare(`INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
    VALUES (?1, ?2, 3, ?3, ?4, ?5)`).bind(scenarioId, rev, JSON.stringify(doc), state, createdAt).run();
}

async function seedExecution(id: string, state: string) {
  await seedHost();
  await env.DB.prepare(`INSERT INTO runtime_executions (id, user_id, host_id, domain_kind, domain_id, generation, state)
    VALUES (?1, ?2, ?3, 'scenario', ?1, 1, ?4)`).bind(id, USER, HOST, state).run();
}

async function seedRun(runId: string, scenarioId: string, rev: string, executionState: string) {
  await seedExecution(runId, executionState);
  await env.DB.prepare(`INSERT INTO scenario_runs
    (run_id, user_id, host_id, runtime_execution_id, scenario_id, scenario_name, scenario_rev, title, tagline, briefing_markdown,
     objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, vm_count, state, state_rank, state_json)
    VALUES (?1, ?2, ?3, ?1, ?4, ?4, ?5, 'T', '', '', '[]', 'easy', 1, '[]', '[]', '', 1, 'ready', 1, '{}')`)
    .bind(runId, USER, HOST, scenarioId, rev).run();
}

async function seedDesired(doc: unknown) {
  await seedHost();
  await env.DB.prepare("INSERT INTO host_desired_state (host_id, version, doc_json) VALUES (?1, 1, ?2)")
    .bind(HOST, JSON.stringify(doc)).run();
}

const desiredDoc = (fields: Record<string, unknown>) => ({
  scope: "platform", owner_user_id: USER, schema_version: 7, host_id: HOST, version: 1, generated_at_unix_ms: 0,
  cached_images: [], vms: [], builds: [], source_compiles: [], ...fields,
});

/** A revision document whose images (unless `built` is false) and specs are stored. */
async function revisionImage(built = true): Promise<{ doc: ReturnType<typeof revisionDoc>; keep: string[] }> {
  const images = built ? { web: await image(), client: await image() } : {};
  const specs = { web: await specBlob(`web-${n++}`), client: await specBlob(`client-${n++}`) };
  const doc = revisionDoc(images, specs);
  const verify = await blob(JSON.stringify({ spec: "verify" }));
  await bucket.put(key(verify.digest), verify.bytes);
  for (const machine of doc.machines) machine.verify_spec = verify.digest;
  const imageKeys = built ? [...await closure(images.web!), ...await closure(images.client!)] : [];
  return { doc, keep: [...imageKeys, key(specs.web), key(specs.client), key(verify.digest)] };
}

const delete_ = (options: OciSweepOptions = {}, nowMs = later(), kinoPinsJson: string | null = "", sweepEnv: OciSweepEnv = env) =>
  runOciSweep(sweepEnv, { mode: "delete", nowMs, kinoPinsJson }, options);
const plan = (nowMs = later(), kinoPinsJson: string | null = "") =>
  runOciSweep(env, { mode: "report-only", nowMs, kinoPinsJson });

beforeEach(async () => {
  await resetD1Database();
  await setRegistryEnforcement({ DB: env.DB }, "enforce");
});

/** One case per root kind: it seeds the root and returns the keys the sweep must keep. */
const ROOTS: Array<[string, () => Promise<{ keep: string[]; pins?: string }>]> = [
  ["a live revision", async () => {
    const { doc, keep } = await revisionImage();
    await seedScenario("intar/live", { live: "r1" });
    await seedRevision("intar/live", "r1", "verified", doc);
    return { keep };
  }],
  ["a candidate revision", async () => {
    const { doc, keep } = await revisionImage();
    await seedScenario("intar/cand", { candidate: "r1" });
    await seedRevision("intar/cand", "r1", "ready", doc);
    return { keep };
  }],
  ["a building revision and its build key's image", async () => {
    const { doc, keep } = await revisionImage(false);
    const built = await image();
    doc.machines[0]!.build_key = `sha256:${"c".repeat(64)}`;
    await env.DB.prepare(`INSERT INTO machine_builds (build_key, image_format, bundle_rev, state, image_digest, updated_at)
      VALUES (?1, 'intar-image-3', 'b', 'succeeded', ?2, 0)`).bind(doc.machines[0]!.build_key, built).run();
    await seedScenario("intar/build");
    await seedRevision("intar/build", "r1", "building", doc);
    return { keep: [...keep, ...await closure(built)] };
  }],
  ["a verified revision among the newest three", async () => {
    const { doc, keep } = await revisionImage();
    await seedScenario("intar/ver");
    await seedRevision("intar/ver", "r1", "verified", doc);
    return { keep };
  }],
  ["a revision a running run started from", async () => {
    const { doc, keep } = await revisionImage();
    await seedScenario("intar/run", { live: "r2", candidate: "r2" });
    await seedRevision("intar/run", "r1", "ready", doc, 1);
    await seedRevision("intar/run", "r2", "building", revisionDoc({}, { web: `sha256:${"7".repeat(64)}`, client: `sha256:${"7".repeat(64)}` }), 2);
    for (const digit of ["7", "9"]) await bucket.put(`oci/sha256/${digit.repeat(64)}`, "s");
    await seedRun("run-1", "intar/run", "r1", "ready");
    return { keep };
  }],
  ["a build in flight", async () => {
    const built = await image();
    await env.DB.prepare(`INSERT INTO machine_builds (build_key, image_format, bundle_rev, state, image_digest, attempt, updated_at)
      VALUES (?1, 'intar-image-3', 'b', 'building', ?2, 1, 0)`).bind(`sha256:${"d".repeat(64)}`, built).run();
    return { keep: await closure(built) };
  }],
  ["a build that finished within the age guard", async () => {
    const built = await image();
    await env.DB.prepare(`INSERT INTO machine_builds (build_key, image_format, bundle_rev, state, image_digest, attempt, updated_at)
      VALUES (?1, 'intar-image-3', 'b', 'succeeded', ?2, 1, ?3)`).bind(`sha256:${"e".repeat(64)}`, built, later()).run();
    return { keep: await closure(built) };
  }],
  ["an active run's snapshot", async () => {
    const [vmImage, pin, spec] = [await image(), await kino(), await specBlob(`run-${n++}`)];
    await seedExecution("exec-1", "archiving");
    await env.DB.prepare(`INSERT INTO runtime_vms (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256,
      cpu_millis, memory_mib, disk_mib) VALUES ('rv-1', 'exec-1', 'vm-1', 0, 'web', ?1, ?2, 1000, 512, 4096)`)
      .bind(JSON.stringify({ build_key: `sha256:${"b".repeat(64)}`, spec, kino: pin }), vmImage).run();
    return { keep: [...await closure(vmImage), ...await closure(pin), key(spec)] };
  }],
  ["a bridge 9 desired state", async () => {
    const [vmImage, vmKino, cached, pin, spec] = [await image(), await kino(), await image(), await kino(), await specBlob(`d-${n++}`)];
    await seedDesired(desiredDoc({ kino_pin: pin, cached_images: [cached], vms: [{ image: vmImage, kino: vmKino, spec }] }));
    return { keep: [...await closure(vmImage), ...await closure(vmKino), ...await closure(cached), ...await closure(pin), key(spec)] };
  }],
  ["an unexpired preparation", async () => {
    const prepared = await image();
    await seedHost();
    await env.DB.prepare(`INSERT INTO personal_image_preparations (user_id, host_id, credential_generation, request_key, access_json,
      images_json, expires_at) VALUES (?1, ?2, 1, 'k', '{}', ?3, ?4)`).bind(USER, HOST, JSON.stringify([prepared]), later() + 60_000).run();
    return { keep: await closure(prepared) };
  }],
  ["the Kino pins, current and previous", async () => {
    const [current, previous] = [await kino(), await kino()];
    return { keep: [...await closure(current), ...await closure(previous)], pins: JSON.stringify({ 3: { current, previous } }) };
  }],
  ["an old Kino artifact that no pin names", async () => ({ keep: await closure(await kino()) })],
];

describe("the OCI sweep", () => {
  it.each(ROOTS)("keeps %s with its config, layers and specs, and deletes what nothing references", async (_name, seed) => {
    const { keep, pins = "" } = await seed();
    const orphan = await image();
    const orphanKeys = await closure(orphan);

    const report = await delete_({}, later(), pins);

    expect(report.faults).toEqual([]);
    expect(report.error).toBeNull();
    expect(report.completed).toBe(true);
    expect(await present(keep)).toBe(true);
    expect(await absent(orphanKeys)).toBe(true);
    expect(report.deletedObjects).toBe(orphanKeys.length);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM registry_manifests WHERE digest = ?1").bind(orphan).first("n")).toBe(0);
  });

  it("plans in report-only mode and deletes nothing", async () => {
    const orphan = await image();
    const orphanKeys = await closure(orphan);

    const report = await plan();

    expect(report.mode).toBe("report-only");
    expect(report.candidateObjects).toBe(orphanKeys.length);
    expect(report.candidateBytes).toBeGreaterThan(0);
    expect([...report.candidateSample].sort()).toEqual([...orphanKeys].sort());
    expect(report.deletedObjects).toBe(0);
    expect(await present(orphanKeys)).toBe(true);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM image_registry_gc_runs").first("n");
    expect(runs).toBe(0);
  });

  it("keeps young objects: a blob pushed before its manifest and a spec written before its revision", async () => {
    const pushed = await blob("a chunk whose manifest is not here yet");
    await bucket.put(key(pushed.digest), pushed.bytes);
    const spec = await specBlob("ingest");

    const report = await delete_({}, Date.now());

    expect(report.youngObjects).toBe(2);
    expect(report.candidateObjects).toBe(0);
    expect(await present([key(pushed.digest), key(spec)])).toBe(true);
  });

  it("keeps the old blobs of a manifest indexed within the age guard", async () => {
    const fresh = await image();
    const keep = await closure(fresh);
    const now = later();
    await env.DB.prepare("UPDATE registry_manifests SET created_at = ?1 WHERE digest = ?2").bind(now, fresh).run();

    const report = await delete_({}, now);

    expect(report.error).toBeNull();
    expect(await present(keep)).toBe(true);
  });

  it.each([
    ["a root's manifest row is missing", "manifest_row_missing", async (root: string) => {
      await env.DB.prepare("DELETE FROM registry_manifest_blobs WHERE manifest_digest = ?1").bind(root).run();
      await env.DB.prepare("DELETE FROM registry_manifests WHERE digest = ?1").bind(root).run();
    }],
    ["a root's index rows are missing", "index_rows_missing", async (root: string) => {
      await env.DB.prepare("DELETE FROM registry_manifest_blobs WHERE manifest_digest = ?1").bind(root).run();
    }],
    ["a root digest is malformed", "malformed_root", async () => {
      await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.cached_images[#]', 'sha256:not-a-digest')").run();
    }],
    ["a marked object is not in the bucket", "referenced_object_missing", async (root: string) => {
      await bucket.delete(key(root));
    }],
  ])("stops with nothing deleted when %s", async (_name, code, damage) => {
    const root = await image();
    await seedDesired(desiredDoc({ cached_images: [root] }));
    const orphanKeys = await closure(await image());
    await damage(root);

    const report = await delete_();

    expect(report.faults.map((fault) => fault.code)).toContain(code);
    expect(report.deletedObjects).toBe(0);
    expect(report.error).toMatch(/^the mark stopped the sweep/);
    expect(await present(orphanKeys)).toBe(true);
  });

  it("stops with nothing deleted when the Kino pins cannot be read", async () => {
    const orphanKeys = await closure(await image());
    for (const pins of [null, "not json", JSON.stringify({ 3: { current: "sha256:x" } })]) {
      const report = await delete_({}, later(), pins);
      expect(report.faults[0]?.code).toMatch(/^kino_pins_/);
      expect(report.deletedObjects).toBe(0);
    }
    expect(await present(orphanKeys)).toBe(true);
    expect(readKinoPins("")).toEqual({ digests: [] });
  });

  it("stops with nothing deleted when D1 errors or the listing is truncated", async () => {
    const orphanKeys = await closure(await image());
    const failingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("roots(kind")) throw new Error("D1_ERROR: injected");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const truncatedBucket = new Proxy(bucket, {
      get(target, property) {
        if (property === "list") {
          return async (options: R2ListOptions) => ({ ...(await target.list(options)), truncated: true, cursor: undefined });
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const d1 = await delete_({}, later(), "", { DB: failingDb, VM_IMAGE_REGISTRY_BUCKET: bucket });
    const listing = await delete_({}, later(), "", { DB: env.DB, VM_IMAGE_REGISTRY_BUCKET: truncatedBucket });

    expect(d1.faults.map((fault) => fault.code)).toEqual(["d1_read_failed"]);
    expect(listing.faults.map((fault) => fault.code)).toEqual(["listing_truncated"]);
    expect(d1.deletedObjects + listing.deletedObjects).toBe(0);
    expect(await present(orphanKeys)).toBe(true);
    // Each failed pass released its lease.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM image_registry_gc_runs WHERE state = 'failed'").first("n")).toBe(2);
  });

  it("does not run while a writer is admitted, or while enforcement is off", async () => {
    const orphanKeys = await closure(await image());
    const writer = await admitInternalRegistryOperation({ DB: env.DB }, { operation: "run_start", owner: { kind: "system", id: "w" } });
    expect(writer.ok).toBe(true);

    const busy = await delete_();
    expect(busy.error).toBe("registry admission is busy");

    if (writer.ok) await writer.lease.complete("ok");
    await setRegistryEnforcement({ DB: env.DB }, "report_only");
    const withheld = await delete_();
    expect(withheld.error).toBe("registry admission enforcement is report_only");

    expect(busy.deletedObjects + withheld.deletedObjects).toBe(0);
    expect(await present(orphanKeys)).toBe(true);
  });

  it("never lists a key outside oci/sha256/ for deletion", async () => {
    const hex = "f".repeat(64);
    const outside = [`builds/bundles/rev.json.gz`, `builds/logs/${hex}`, `images/a-b-x86_64/${hex}.raw.zst`,
      `image-chunks/v1/zstd6/${hex}`, `image-manifests/v1/${hex}.json`, `artifacts/${hex}`, `oci/${hex}`];
    const malformed = "oci/sha256/not-a-digest";
    for (const k of [...outside, malformed]) await bucket.put(k, "x");

    const report = await delete_();

    expect(report.unrecognizedObjects).toBe(1);
    expect(report.candidateSample).toEqual([]);
    expect(await present([...outside, malformed])).toBe(true);
  });

  it("plans the whole store over successive windows, each key once, and writes nothing", async () => {
    const keys = (await Promise.all([image(), image(), image()].map(async (digest) => closure(await digest)))).flat();
    const options = { listPages: 1, listPageLimit: 4 };

    const seen: string[] = [];
    let listed = 0;
    let startAfter: string | null = "";
    let windows = 0;
    while (startAfter !== null && windows < 20) {
      const report = await runOciSweep(env, { mode: "report-only", nowMs: later(), kinoPinsJson: "", startAfter }, options);
      expect(report.faults).toEqual([]);
      expect(report.listedObjects).toBeLessThanOrEqual(4);
      listed += report.listedObjects;
      seen.push(...report.candidateSample);
      startAfter = report.nextStartAfter;
      windows += 1;
    }

    expect(windows).toBe(Math.ceil(keys.length / 4));
    expect(listed).toBe(keys.length);
    expect(seen.length).toBe(keys.length);
    expect([...seen].sort()).toEqual([...keys].sort());
    expect(await present(keys)).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM image_registry_gc_runs").first("n")).toBe(0);
    const bad = await runOciSweep(env, { mode: "report-only", nowMs: later(), kinoPinsJson: "", startAfter: "oci/../x" });
    expect(bad.faults.map((fault) => fault.code)).toEqual(["invalid_start_after"]);
  });

  it("finishes over resumed passes without deleting twice or skipping", async () => {
    const root = await image();
    await seedDesired(desiredDoc({ cached_images: [root] }));
    const keep = await closure(root);
    const orphans = (await Promise.all([image(), image(), image()].map(async (digest) => closure(await digest)))).flat();
    const options = { listPages: 1, listPageLimit: 4, maxDeletes: 2, batchSize: 1 };

    let deleted = 0;
    const cursors: Array<string | null> = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const report = await delete_(options);
      expect(report.error).toBeNull();
      expect(report.deletedObjects).toBeLessThanOrEqual(2);
      deleted += report.deletedObjects;
      cursors.push(report.nextStartAfter);
      if (report.completed) break;
    }

    expect(cursors.at(-1)).toBeNull();
    expect(cursors.length).toBeGreaterThan(2);
    expect(deleted).toBe(orphans.length);
    expect(await absent(orphans)).toBe(true);
    expect(await present(keep)).toBe(true);
  });

  it("keeps a blob a referenced and an unreferenced manifest share", async () => {
    const shared = await blob("shared chunk");
    const config = { guest_contract: 3 };
    const kept = await store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json", { ...config, a: 1 },
      [["application/vnd.intar.disk.chunk.v1+zstd", "shared chunk"]]);
    const dropped = await store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json", { ...config, b: 1 },
      [["application/vnd.intar.disk.chunk.v1+zstd", "shared chunk"]]);
    await seedDesired(desiredDoc({ cached_images: [kept] }));
    const droppedOnly = (await closure(dropped)).filter((k) => k !== key(shared.digest));

    const report = await delete_();

    expect(report.error).toBeNull();
    expect(await present(await closure(kept))).toBe(true);
    expect(await present([key(shared.digest)])).toBe(true);
    expect(await absent(droppedOnly)).toBe(true);
  });

  it("keeps a run's image through a pass in which the run ends, and refuses new writers during it", async () => {
    // The mark is read under the sweep lease, before the listing and the
    // deletes. A reference removed after the mark only shrinks the next
    // pass's mark; a reference added after it would need a writer, which the
    // lease refuses until the pass ends.
    const vmImage = await image();
    await seedExecution("exec-1", "ready");
    await env.DB.prepare(`INSERT INTO runtime_vms (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256,
      cpu_millis, memory_mib, disk_mib) VALUES ('rv-1', 'exec-1', 'vm-1', 0, 'web', ?1, ?2, 1000, 512, 4096)`)
      .bind(JSON.stringify({ build_key: `sha256:${"b".repeat(64)}`, spec: `sha256:${"9".repeat(64)}`, kino: vmImage }), vmImage).run();
    await bucket.put(`oci/sha256/${"9".repeat(64)}`, "spec");
    const keep = await closure(vmImage);
    let writerDuringPass: boolean | null = null;
    const endsMidPass = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("marked(digest)")) return statement;
            return new Proxy(statement, {
              get(inner, name) {
                if (name !== "bind") return Reflect.get(inner, name);
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  return { all: async () => {
                    const marked = await bound.all();
                    await target.prepare("UPDATE runtime_executions SET state = 'archived' WHERE id = 'exec-1'").run();
                    const writer = await admitInternalRegistryOperation({ DB: target }, { operation: "run_start", owner: { kind: "system", id: "w" } });
                    writerDuringPass = writer.ok;
                    return marked;
                  } };
                };
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const during = await delete_({}, later(), "", { DB: endsMidPass, VM_IMAGE_REGISTRY_BUCKET: bucket });
    expect(during.error).toBeNull();
    expect(writerDuringPass).toBe(false);
    expect(await present(keep)).toBe(true);

    const after = await delete_();
    expect(after.error).toBeNull();
    expect(await absent(keep)).toBe(true);
  });

  it("removes old revisions nothing keeps, apart from the object sweep", async () => {
    const { doc } = await revisionImage();
    const old = 1;
    await seedScenario("intar/gc", { live: "live", candidate: "cand" });
    await seedRevision("intar/gc", "live", "verified", doc, old);
    await seedRevision("intar/gc", "cand", "ready", doc, old);
    for (const rev of ["v1", "v2", "v3", "v4"]) await seedRevision("intar/gc", rev, "verified", doc, old + Number(rev[1]));
    await seedRevision("intar/gc", "failed-old", "failed", doc, old);
    await seedRevision("intar/gc", "ready-old", "ready", doc, old);
    await seedRevision("intar/gc", "building", "building", doc, old);
    await seedRevision("intar/gc", "running", "ready", doc, old);
    await seedRun("run-1", "intar/gc", "running", "provisioning");
    await seedRevision("intar/gc", "failed-young", "failed", doc, later());
    const revs = async () => (await env.DB.prepare("SELECT rev FROM scenario_revisions ORDER BY rev").all<{ rev: string }>())
      .results.map((row) => row.rev);
    const before = await revs();

    const planned = await plan();
    expect(planned.revisionCandidates).toBe(3);
    expect(await revs()).toEqual(before);

    const swept = await delete_();
    expect(swept.error).toBeNull();
    expect(swept.deletedRevisions).toBe(3);
    // Of the five verified, the newest three are v2, v3 and v4; live stays by its pointer.
    expect(await revs()).toEqual(["building", "cand", "failed-young", "live", "running", "v2", "v3", "v4"]);
  });

  it("runs behind the collector's gate and reports beside the old pass", async () => {
    const orphan = await blob("an unindexed blob");
    await bucket.put(key(orphan.digest), orphan.bytes);
    const orphanKeys = [key(orphan.digest)];
    const parent = (pins: string) => new MaintenanceState(createExecutionContext(), new Proxy(env, {
      get: (target, property, receiver) => property === "KINO_PINS_JSON" ? pins : Reflect.get(target, property, receiver),
    }));
    const child = (mode: string): CleanupEnv => ({
      DB: env.DB, VM_IMAGE_REGISTRY_BUCKET: bucket, REGISTRY_CLEANUP_MODE: mode, CONTROL_PLANE: parent(""),
    });

    const reported = await runCleanup(child("report-only"), { source: "rpc" });
    expect(reported.oci?.status).toBe("report-only");
    // The live clock is inside the age guard of everything stored here.
    expect(reported.oci?.report.youngObjects).toBe(orphanKeys.length);
    expect(await present(orphanKeys)).toBe(true);

    const planOnly = await runCleanup(child("delete"), { source: "rpc", planOnly: true });
    expect(planOnly.oci?.report.mode).toBe("report-only");
    expect(await present(orphanKeys)).toBe(true);

    const deleting = await runCleanup(child("delete"), { source: "rpc" });
    expect(deleting.oci?.report.mode).toBe("delete");
    expect(deleting.oci?.report.youngObjects).toBe(orphanKeys.length);
    expect(await present(orphanKeys)).toBe(true);
  });
});
