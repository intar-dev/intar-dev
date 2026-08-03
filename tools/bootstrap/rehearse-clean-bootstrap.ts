#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildCleanD1Import } from "../cutover/build-clean-d1-import";

const repositoryRoot = resolve(import.meta.dir, "../..");
const baselinePath = resolve(
  repositoryRoot,
  "apps/web/migrations/0000_clean_multicloud.sql",
);
const scenarioPath = resolve(
  repositoryRoot,
  "content/scenarios/broken-nginx/scenario.hcl",
);
const coursePath = resolve(repositoryRoot, "content/courses.hcl");
const workshopSourceLockPath = resolve(
  repositoryRoot,
  "content/workshops/platform-engineering/locks/source.lock.json",
);

const baseline = readFileSync(baselinePath, "utf8");
const scenarioHcl = readFileSync(scenarioPath, "utf8");
const courseHcl = readFileSync(coursePath, "utf8");
const workshopSourceLockRaw = readFileSync(workshopSourceLockPath, "utf8");
const workshopSourceLock = JSON.parse(workshopSourceLockRaw) as {
  revision: string;
  archiveSha256: string;
  license: string;
  licenseSha256: string;
};

const scenarioSourceRevision = sha256(scenarioHcl);
const courseSourceRevision = sha256(courseHcl);
const workshopManifest = {
  formatVersion: 2,
  slug: "platform-engineering-workshop",
  source: {
    revision: workshopSourceLock.revision,
    archiveSha256: workshopSourceLock.archiveSha256,
    license: workshopSourceLock.license,
    licenseSha256: workshopSourceLock.licenseSha256,
  },
  workspace: {
    vm: {
      id: "learner",
      cpuMillis: 4_000,
      memoryMiB: 16_384,
      diskMiB: 32_768,
    },
    runtimeProfiles: ["hetzner-cpx42", "gcp-e2-standard-4"],
  },
};
const workshopManifestJson = stableJson(workshopManifest);
const workshopContentHash = sha256(workshopManifestJson);
const fixedNow = 1_775_000_000_000;
const baselineStatements = baseline
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const ids = {
  owner: "bootstrap-owner",
  organization: "bootstrap-pilot-org",
  membership: "bootstrap-pilot-owner-membership",
  scenarioSource: "bootstrap-scenario-broken-nginx",
  registryToken: "bootstrap-registry-token-sentinel",
  template: "bootstrap-workshop-platform-engineering",
  revision: `bootstrap-workshop-revision-${workshopContentHash.slice(0, 16)}`,
  hetznerProfile: "bootstrap-profile-hetzner-cpx42",
  gcpProfile: "bootstrap-profile-gcp-e2-standard-4",
  publication: "bootstrap-publication-platform-engineering",
  checkpoint: "bootstrap-publication-checkpoint-00",
} as const;

const database = new Database(":memory:", { strict: true });

try {
  applyBaseline(database);
  const bootstrap = database.transaction(() => seedBootstrap(database));

  bootstrap();
  const firstSnapshot = bootstrapSnapshot(database);
  bootstrap();
  const secondSnapshot = bootstrapSnapshot(database);

  assert(
    isDeepStrictEqual(firstSnapshot, secondSnapshot),
    "the second bootstrap changed the seeded database state",
  );
  verifyBootstrap(database);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        database: "fresh in-memory SQLite",
        baselineStatements: baselineStatements.length,
        bootstrapRuns: 2,
        ownerId: ids.owner,
        organizationId: ids.organization,
        scenarioSourceRevision,
        courseSourceRevision,
        workshopSourceRevision: workshopSourceLock.revision,
        workshopContentHash,
        runtimeProfiles: ["hetzner-cpx42", "gcp-e2-standard-4"],
        productionMutated: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  database.close(false);
}

function applyBaseline(db: Database): void {
  assert(baselineStatements.length > 0, "the clean baseline contains no statements");
  db.exec(buildCleanD1Import(baseline));
  const ledger = db
    .query("SELECT name FROM d1_migrations ORDER BY id")
    .all() as Array<{ name: string }>;
  assert(
    isDeepStrictEqual(ledger, [{ name: "0000_clean_multicloud.sql" }]),
    "the clean baseline import did not record the exact migration ledger",
  );
}

function seedBootstrap(db: Database): void {
  db.query(
    `INSERT INTO user (
       id, name, email, email_verified, created_at, updated_at, role
     ) VALUES (?, ?, ?, 1, ?, ?, 'admin')
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       email = excluded.email,
       email_verified = excluded.email_verified,
       updated_at = excluded.updated_at,
       role = excluded.role`,
  ).run(ids.owner, "Bootstrap Owner", "owner@bootstrap.invalid", fixedNow, fixedNow);

  db.query(
    `INSERT INTO organization (id, name, slug, created_at, metadata)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       metadata = excluded.metadata`,
  ).run(
    ids.organization,
    "Bootstrap Pilot Organization",
    "bootstrap-pilot",
    fixedNow,
    stableJson({ rehearsal: true }),
  );

  // Use INSERT ... WHERE NOT EXISTS here because the owner uniqueness guard is
  // intentionally evaluated before SQLite's ON CONFLICT handling.
  db.query(
    `INSERT INTO member (id, organization_id, user_id, role, created_at)
     SELECT ?, ?, ?, 'owner', ?
     WHERE NOT EXISTS (SELECT 1 FROM member WHERE id = ?)`,
  ).run(ids.membership, ids.organization, ids.owner, fixedNow, ids.membership);

  db.query(
    `INSERT INTO scenario_sources (
       id, scenario_id, hcl, status, created_by, created_at, updated_at,
       organization_id
     ) VALUES (?, 'broken-nginx', ?, 'published', ?, ?, ?, ?)
     ON CONFLICT(scenario_id) DO UPDATE SET
       hcl = excluded.hcl,
       status = excluded.status,
       updated_at = excluded.updated_at,
       organization_id = excluded.organization_id`,
  ).run(
    ids.scenarioSource,
    scenarioHcl,
    ids.owner,
    fixedNow,
    fixedNow,
    ids.organization,
  );

  const coursesJson = stableJson({
    formatVersion: 1,
    sourceRevision: courseSourceRevision,
    sourceHcl: courseHcl,
    courses: [
      {
        slug: "linux-operations",
        scenarioIds: ["broken-nginx"],
      },
    ],
  });
  db.query(
    `INSERT INTO scenario_course_catalogs (
       scope_key, organization_id, courses_json, source_revision,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       courses_json = excluded.courses_json,
       source_revision = excluded.source_revision,
       updated_at = excluded.updated_at`,
  ).run(
    `organization:${ids.organization}`,
    ids.organization,
    coursesJson,
    courseSourceRevision,
    fixedNow,
    fixedNow,
  );

  db.query(
    `INSERT INTO workshop_registry_tokens (
       id, organization_id, name, token_prefix, token_hash, created_by,
       created_at
     )
     SELECT ?, ?, 'Bootstrap rehearsal sentinel', 'rehearsal', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM workshop_registry_tokens WHERE id = ?)`,
  ).run(
    ids.registryToken,
    ids.organization,
    sha256("non-secret-bootstrap-rehearsal-sentinel"),
    ids.owner,
    fixedNow,
    ids.registryToken,
  );

  db.query(
    `INSERT INTO workshop_templates (
       id, organization_id, slug, title, summary, created_by,
       created_at, updated_at
     ) VALUES (?, ?, 'platform-engineering-workshop', ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, slug) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       updated_at = excluded.updated_at`,
  ).run(
    ids.template,
    ids.organization,
    "Platform Engineering Workshop",
    "Clean-bootstrap publication rehearsal",
    ids.owner,
    fixedNow,
    fixedNow,
  );

  db.query(
    `INSERT INTO workshop_template_revisions (
       id, template_id, revision, source_revision, content_hash,
       manifest_json, published_by, published_at
     )
     SELECT ?, ?, 1, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM workshop_template_revisions
       WHERE template_id = ? AND revision = 1
     )`,
  ).run(
    ids.revision,
    ids.template,
    workshopSourceLock.revision,
    workshopContentHash,
    workshopManifestJson,
    ids.owner,
    fixedNow,
    ids.template,
  );

  insertRuntimeProfile(db, {
    id: ids.hetznerProfile,
    profileId: "hetzner-cpx42",
    providerKind: "hetzner_cloud",
    machineType: "cpx42",
    systemImage: "debian-13",
    resolvedImageId: "debian-13-bootstrap-rehearsal",
    rootDiskType: null,
    cpuMillis: 8_000,
    memoryMiB: 16_384,
    diskMiB: 163_840,
    locations: ["nbg1", "fsn1", "hel1"],
  });
  insertRuntimeProfile(db, {
    id: ids.gcpProfile,
    profileId: "gcp-e2-standard-4",
    providerKind: "gcp_compute",
    machineType: "e2-standard-4",
    systemImage: "projects/debian-cloud/global/images/family/debian-13",
    resolvedImageId:
      "projects/debian-cloud/global/images/debian-13-bootstrap-rehearsal",
    rootDiskType: "pd-balanced",
    cpuMillis: 4_000,
    memoryMiB: 16_384,
    diskMiB: 32_768,
    locations: ["europe-west3-a", "europe-west3-b", "europe-west3-c"],
  });

  db.query(
    `UPDATE workshop_templates
     SET current_revision_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(ids.revision, fixedNow, ids.template);

  db.query(
    `INSERT INTO workshop_publications (
       id, organization_id, workshop_slug, content_hash, source_r2_key,
       compiled_manifest_json, required_checkpoint_ids_json, status,
       submitted_by, registry_token_id, published_revision_id,
       finished_at, created_at, updated_at
     )
     SELECT ?, ?, 'platform-engineering-workshop', ?, ?, ?, '["00"]',
            'published', ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM workshop_publications WHERE id = ?)`,
  ).run(
    ids.publication,
    ids.organization,
    workshopContentHash,
    `bootstrap-rehearsal/${workshopContentHash}.tar.zst`,
    workshopManifestJson,
    ids.owner,
    ids.registryToken,
    ids.revision,
    fixedNow,
    fixedNow,
    fixedNow,
    ids.publication,
  );

  db.query(
    `INSERT INTO workshop_publication_checkpoints (
       id, publication_id, checkpoint_id, status, vm_images_json,
       sanitized, cold_boot_verified, verified_at, created_at, updated_at
     )
     SELECT ?, ?, '00', 'verified', '{}', 1, 1, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM workshop_publication_checkpoints WHERE id = ?
     )`,
  ).run(
    ids.checkpoint,
    ids.publication,
    fixedNow,
    fixedNow,
    fixedNow,
    ids.checkpoint,
  );
}

function insertRuntimeProfile(
  db: Database,
  profile: {
    id: string;
    profileId: string;
    providerKind: "hetzner_cloud" | "gcp_compute";
    machineType: string;
    systemImage: string;
    resolvedImageId: string;
    rootDiskType: string | null;
    cpuMillis: number;
    memoryMiB: number;
    diskMiB: number;
    locations: string[];
  },
): void {
  db.query(
    `INSERT INTO workshop_runtime_profiles (
       id, template_revision_id, profile_id, provider_kind, vm_id,
       machine_type, system_image, resolved_image_id, root_disk_type,
       architecture, cpu_millis, memory_mib, disk_mib, locations_json,
       configuration_json, created_at
     )
     SELECT ?, ?, ?, ?, 'learner', ?, ?, ?, ?, 'x86_64', ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM workshop_runtime_profiles WHERE id = ?)`,
  ).run(
    profile.id,
    ids.revision,
    profile.profileId,
    profile.providerKind,
    profile.machineType,
    profile.systemImage,
    profile.resolvedImageId,
    profile.rootDiskType,
    profile.cpuMillis,
    profile.memoryMiB,
    profile.diskMiB,
    stableJson(profile.locations),
    stableJson({ rehearsal: true }),
    fixedNow,
    profile.id,
  );
}

function bootstrapSnapshot(db: Database): unknown {
  const tables = [
    "user",
    "organization",
    "member",
    "scenario_sources",
    "scenario_course_catalogs",
    "workshop_registry_tokens",
    "workshop_templates",
    "workshop_template_revisions",
    "workshop_runtime_profiles",
    "workshop_publications",
    "workshop_publication_checkpoints",
  ] as const;

  return Object.fromEntries(
    tables.map((table) => [
      table,
      db.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}

function verifyBootstrap(db: Database): void {
  const expectedCounts = {
    user: 1,
    organization: 1,
    member: 1,
    scenario_sources: 1,
    scenario_course_catalogs: 1,
    workshop_registry_tokens: 1,
    workshop_templates: 1,
    workshop_template_revisions: 1,
    workshop_runtime_profiles: 2,
    workshop_publications: 1,
    workshop_publication_checkpoints: 1,
  } as const;

  for (const [table, expected] of Object.entries(expectedCounts)) {
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    assert(row.count === expected, `${table}: expected ${expected}, got ${row.count}`);
  }

  const owner = db
    .query(
      `SELECT member.role, member.organization_id, member.user_id
       FROM member
       WHERE member.id = ?`,
    )
    .get(ids.membership) as
    | { role: string; organization_id: string; user_id: string }
    | null;
  assert(owner?.role === "owner", "bootstrap owner membership is missing");
  assert(owner.organization_id === ids.organization, "owner organization mismatch");
  assert(owner.user_id === ids.owner, "owner user mismatch");

  const template = db
    .query("SELECT current_revision_id FROM workshop_templates WHERE id = ?")
    .get(ids.template) as { current_revision_id: string | null } | null;
  assert(
    template?.current_revision_id === ids.revision,
    "workshop template does not point at its published revision",
  );

  const profiles = db
    .query(
      `SELECT profile_id, provider_kind, machine_type
       FROM workshop_runtime_profiles
       ORDER BY profile_id`,
    )
    .all() as Array<{
    profile_id: string;
    provider_kind: string;
    machine_type: string;
  }>;
  assert(
    isDeepStrictEqual(profiles, [
      {
        profile_id: "gcp-e2-standard-4",
        provider_kind: "gcp_compute",
        machine_type: "e2-standard-4",
      },
      {
        profile_id: "hetzner-cpx42",
        provider_kind: "hetzner_cloud",
        machine_type: "cpx42",
      },
    ]),
    "published runtime profiles do not match the clean bootstrap contract",
  );

  const publication = db
    .query(
      `SELECT status, published_revision_id
       FROM workshop_publications
       WHERE id = ?`,
    )
    .get(ids.publication) as
    | { status: string; published_revision_id: string | null }
    | null;
  assert(publication?.status === "published", "workshop publication is not published");
  assert(
    publication.published_revision_id === ids.revision,
    "workshop publication revision mismatch",
  );

  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  assert(
    foreignKeyViolations.length === 0,
    `foreign-key violations: ${JSON.stringify(foreignKeyViolations)}`,
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (
      currentValue === null ||
      typeof currentValue !== "object" ||
      Array.isArray(currentValue)
    ) {
      return currentValue;
    }
    return Object.fromEntries(
      Object.entries(currentValue as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
