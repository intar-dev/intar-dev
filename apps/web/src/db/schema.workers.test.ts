import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  databaseMigrations,
  resetDatabase,
} from "@/test/database-migrations";

beforeEach(resetDatabase);

describe("Drizzle-managed production D1 schema", () => {
  it("hard-cuts enabled scenarios in every scope before V2 publication", async () => {
    await reset();
    const cutoverMigration = databaseMigrations.find(
      ({ name }) => name === "0010_ordinary_crystal.sql",
    );
    if (!cutoverMigration) throw new Error("V2 cutover migration is missing");
    await applyD1Migrations(
      env.DB,
      databaseMigrations.filter(
        ({ name }) => name < "0010_ordinary_crystal.sql",
      ),
    );

    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("org-a", "Organization A", "organization-a", 1),
      env.DB
        .prepare(
          "INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("org-b", "Organization B", "organization-b", 1),
      ...[null, "org-a", "org-b"].map((organizationId, index) =>
        env.DB
          .prepare(
            `INSERT INTO vm_scenarios (
               scenario_id, organization_id, title, category, description,
               difficulty, estimated_minutes, tags_json, briefing_markdown,
               solution_markdown, hints_json, enabled, enabled_at, created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `scenario-${index}`,
            organizationId,
            `Scenario ${index}`,
            "test",
            "Test scenario",
            "easy",
            10,
            "[]",
            "Briefing",
            "Solution",
            "[]",
            index === 1 ? 0 : 1,
            index === 1 ? 99 : 100,
            1,
            1,
          ),
      ),
    ]);

    await applyD1Migrations(env.DB, [cutoverMigration]);

    const scenarios = await env.DB.prepare(
      `SELECT scenario_id, enabled, enabled_at, updated_at
       FROM vm_scenarios ORDER BY scenario_id`,
    ).all<{
      scenario_id: string;
      enabled: number;
      enabled_at: number | null;
      updated_at: number;
    }>();
    expect(scenarios.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenario_id: "scenario-0",
          enabled: 0,
          enabled_at: null,
        }),
        expect.objectContaining({
          scenario_id: "scenario-1",
          enabled: 0,
          enabled_at: null,
        }),
        expect.objectContaining({
          scenario_id: "scenario-2",
          enabled: 0,
          enabled_at: null,
        }),
      ]),
    );
    expect(scenarios.results.every((scenario) => scenario.updated_at > 1)).toBe(
      true,
    );
  });

  it("initializes the complete current table model", async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all<{ name: string }>();
    const names = tables.results.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "user",
        "organization",
        "access_invite_codes",
        "access_invite_removals",
        "access_allowlist",
        "access_events",
        "scenario_runs",
        "course_unit_completions",
        "workshop_templates",
        "workshop_route_issuance_intents",
        "workshop_runtime_profiles",
        "provider_connections",
        "runtime_executions",
        "runtime_provider_allocations",
        "runtime_provider_resources",
        "runtime_provider_operations",
        "provider_price_observations",
        "runtime_provider_cost_ledger",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "clean_d1_commissioning",
        "access_requests",
        "hetzner_allocations",
        "organization_provider_connections",
        "scenario_sources",
      ]),
    );

    const foreignKeyViolations = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(foreignKeyViolations.results).toEqual([]);
  });

  it("contains no custom schema objects", async () => {
    const triggers = await env.DB.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`,
    ).all<{ name: string }>();
    expect(triggers.results).toEqual([]);

    const views = await env.DB.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name`,
    ).all<{ name: string }>();
    expect(views.results).toEqual([]);
  });

  it("retains typed checks, foreign keys, and indexes", async () => {
    const inviteSchema = await tableSql("access_invite_codes");
    expect(inviteSchema).toContain("172800000");
    expect(inviteSchema).toContain("1209600000");

    const allocationColumns = await env.DB.prepare(
      "PRAGMA table_info('runtime_provider_allocations')",
    ).all<{ name: string; notnull: number }>();
    expect(
      allocationColumns.results.find(
        (column) => column.name === "price_observation_id",
      ),
    ).toMatchObject({ notnull: 1 });

    const runtimeVmColumns = await env.DB.prepare(
      "PRAGMA table_info('runtime_vms')",
    ).all<{ name: string; notnull: number }>();
    expect(
      runtimeVmColumns.results.find(
        (column) => column.name === "archive_stage_rank",
      ),
    ).toMatchObject({ notnull: 0 });

    const runColumns = await env.DB.prepare(
      "PRAGMA table_info('scenario_runs')",
    ).all<{ name: string; notnull: number }>();
    expect(runColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "course_scope_key",
        "course_id",
        "lecture_id",
        "lecture_body_markdown",
      ]),
    );

    const routeIndexes = await env.DB.prepare(
      `SELECT name, "unique" AS is_unique
       FROM pragma_index_list('workshop_route_issuance_intents')
       WHERE name IN (
         'workshop_route_issuance_intents_route_uidx',
         'workshop_route_issuance_intents_member_idx'
       ) ORDER BY name`,
    ).all<{ name: string; is_unique: number }>();
    expect(routeIndexes.results).toEqual([
      { name: "workshop_route_issuance_intents_member_idx", is_unique: 0 },
      { name: "workshop_route_issuance_intents_route_uidx", is_unique: 1 },
    ]);

    const contentIndexes = await env.DB.prepare(
      `SELECT name, "unique" AS is_unique
       FROM pragma_index_list('workshop_template_revisions')
       WHERE name IN (
         'workshop_template_revisions_content_idx',
         'workshop_template_revisions_content_uidx'
       ) ORDER BY name`,
    ).all<{ name: string; is_unique: number }>();
    expect(contentIndexes.results).toEqual([
      { name: "workshop_template_revisions_content_idx", is_unique: 0 },
    ]);
  });
});

async function tableSql(name: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`,
  )
    .bind(name)
    .first<{ sql: string }>();
  return row?.sql ?? "";
}
