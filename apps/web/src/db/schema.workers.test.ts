import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/database-migrations";

beforeEach(resetDatabase);

describe("Drizzle-managed production D1 schema", () => {
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
