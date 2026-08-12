import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BETA_CUTOVER_OPERATIONAL_PREFLIGHT_SQL,
  betaCutoverOperationalPreflightQueries,
  betaSchemaStatements,
  buildBetaResetSql,
} from "../../scripts/beta-access-cutover-lib";

const baseline = `
CREATE TABLE \`access_invite_codes\` (\`id\` text);
--> statement-breakpoint
CREATE TABLE \`unrelated\` (\`id\` text);
--> statement-breakpoint
CREATE TABLE \`access_allowlist\` (\`user_id\` text);
--> statement-breakpoint
CREATE TABLE \`access_invite_removals\` (\`invite_id\` text);
--> statement-breakpoint
CREATE TABLE \`access_events\` (\`id\` text);
--> statement-breakpoint
CREATE UNIQUE INDEX \`account_provider_account_uidx\` ON \`account\` (\`provider_id\`, \`account_id\`);
--> statement-breakpoint
CREATE TRIGGER \`access_allowlist_claim_invite\` BEFORE INSERT ON \`access_allowlist\` BEGIN SELECT 1; END;
--> statement-breakpoint
CREATE TRIGGER \`access_user_last_beta_admin_update_guard\` BEFORE UPDATE ON \`user\` BEGIN SELECT 1; END;
`;

const cleanBaseline = readFileSync(
  new URL("../../migrations/0000_clean_multicloud.sql", import.meta.url),
  "utf8",
);
const inviteLifecycleMigration = readFileSync(
  new URL("../../migrations/0003_archive_access_invites.sql", import.meta.url),
  "utf8",
);
const cleanSchemaSources = `${cleanBaseline}\n--> statement-breakpoint\n${inviteLifecycleMigration}`;

describe("pure beta replacement SQL", () => {
  it("requires active and recently terminal scenario routes to be drained without deleting org workloads", () => {
    const scenarioRunCheck =
      BETA_CUTOVER_OPERATIONAL_PREFLIGHT_SQL.split("UNION ALL", 1)[0] ?? "";
    expect(scenarioRunCheck).toContain("'scenario_route_may_be_live'");
    expect(scenarioRunCheck).toContain("user_id || ':' || run_id");
    expect(scenarioRunCheck).toContain("completed_at IS NULL");
    expect(scenarioRunCheck).toContain("updated_at >=");
    expect(scenarioRunCheck).toContain("completed_at >=");
    expect(scenarioRunCheck).toContain("failed_at >=");
    expect(scenarioRunCheck).toContain("hidden_at >=");
    expect(scenarioRunCheck).toContain("14400000");
    expect(scenarioRunCheck).not.toContain("organization_id IS NULL");
    expect(BETA_CUTOVER_OPERATIONAL_PREFLIGHT_SQL).toContain(
      "'connected_personal_agent'",
    );
  });

  it("runs operational preflights as independent D1 queries", () => {
    const queries = betaCutoverOperationalPreflightQueries();

    expect(queries).toHaveLength(6);
    expect(queries.every((query) => !query.includes("UNION ALL"))).toBe(true);
    expect(queries.join("\n")).toContain("workshop_route_issuance_intents");
  });

  it("selects only beta schema and required account indexes", () => {
    const selected = betaSchemaStatements(baseline).join("\n");
    expect(selected).toContain("access_invite_codes");
    expect(selected).toContain("access_invite_removals");
    expect(selected).toContain("account_provider_account_uidx");
    expect(selected).toContain("access_user_last_beta_admin_update_guard");
    expect(selected).not.toContain("unrelated");
  });

  it("clears credentials and replaces beta tables without touching tenants", () => {
    const sql = buildBetaResetSql(baseline, 1234);
    expect(sql).toContain("DELETE FROM session");
    expect(sql).toContain("DELETE FROM oauth_access_token");
    expect(sql).toContain("DELETE FROM verification");
    expect(sql).toContain("'authorization_code'");
    expect(sql).toContain("DELETE FROM user_ssh_keys");
    expect(sql).toContain("UPDATE workshop_registry_tokens");
    expect(sql).toContain("DELETE FROM workshop_route_issuance_intents");
    expect(sql).toContain("application_route_ids_json = '[]'");
    expect(sql).toContain("active_session_id = NULL");
    expect(sql).toContain("DROP TABLE IF EXISTS `access_requests`");
    expect(sql).toContain("DROP TABLE IF EXISTS `access_invite_removals`");
    expect(sql).toContain("CREATE TABLE `access_allowlist`");
    expect(sql).not.toContain("DROP TABLE IF EXISTS `user`");
    expect(sql).not.toContain("DROP TABLE IF EXISTS `organization`");
  });

  it("recreates removal storage and the 14-day invite constraint", () => {
    const sql = buildBetaResetSql(cleanSchemaSources, 1234);
    expect(sql).toContain("CREATE TABLE `access_invite_removals`");
    expect(sql).toContain("1209600000");
    expect(sql).toContain("DROP TABLE IF EXISTS `access_invite_removals`");
  });
});
