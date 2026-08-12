const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const STARGATE_ROUTE_TTL_MS = 4 * 60 * 60 * 1_000;
const POSSIBLY_LIVE_SCENARIO_ROUTE_CUTOFF =
  `cast(unixepoch('subsecond') * 1000 as integer) - ${STARGATE_ROUTE_TTL_MS}`;

export const BETA_CUTOVER_OPERATIONAL_PREFLIGHT_SQL = `
  SELECT 'scenario_route_may_be_live' AS issue,
         user_id || ':' || run_id AS identity
  FROM scenario_runs
  WHERE (completed_at IS NULL AND failed_at IS NULL)
    OR updated_at >= ${POSSIBLY_LIVE_SCENARIO_ROUTE_CUTOFF}
    OR completed_at >= ${POSSIBLY_LIVE_SCENARIO_ROUTE_CUTOFF}
    OR failed_at >= ${POSSIBLY_LIVE_SCENARIO_ROUTE_CUTOFF}
    OR hidden_at >= ${POSSIBLY_LIVE_SCENARIO_ROUTE_CUTOFF}
  UNION ALL
  SELECT 'connected_personal_agent' AS issue, id AS identity
  FROM agent_hosts
  WHERE organization_id IS NULL
    AND (connected = 1 OR active_session_id IS NOT NULL)
  UNION ALL
  SELECT 'workshop_terminal_route' AS issue,
         workspace.id || ':' || CAST(route.value AS TEXT) AS identity
  FROM workshop_workspaces workspace,
       json_each(workspace.terminal_route_usernames_json) route
  UNION ALL
  SELECT 'workshop_application_route' AS issue,
         workspace.id || ':' || CAST(route.value AS TEXT) AS identity
  FROM workshop_workspaces workspace,
       json_each(workspace.application_route_ids_json) route
  UNION ALL
  SELECT 'workshop_assist_route' AS issue,
         grant_record.id || ':' || CAST(route.value AS TEXT) AS identity
  FROM workshop_assist_grants grant_record,
       json_each(grant_record.terminal_route_usernames_json) route
  UNION ALL
  SELECT 'workshop_route_issuance' AS issue, id AS identity
  FROM workshop_route_issuance_intents
`;

export function betaCutoverOperationalPreflightQueries(): string[] {
  return BETA_CUTOVER_OPERATIONAL_PREFLIGHT_SQL.split(/\s+UNION ALL\s+/u)
    .map((query) => query.trim())
    .filter(Boolean);
}

export function betaSchemaStatements(schemaSources: string): string[] {
  const statements = schemaSources
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
  const tables = new Map<string, string>();
  const indexes = new Map<string, string>();
  const triggers = new Map<string, string>();
  const betaTables = [
    "access_invite_codes",
    "access_allowlist",
    "access_events",
    "access_invite_removals",
  ];

  for (const statement of statements) {
    const table = statement.match(/CREATE TABLE `([^`]+)`\s*\(/u)?.[1];
    if (table && betaTables.includes(table)) tables.set(table, statement);

    const index = statement.match(
      /CREATE (?:UNIQUE )?INDEX `([^`]+)`/u,
    )?.[1];
    if (
      index?.startsWith("access_") ||
      index === "account_provider_account_uidx" ||
      index === "account_user_github_uidx"
    ) {
      indexes.set(index, statement);
    }

    const trigger = statement.match(/CREATE TRIGGER `([^`]+)`/u)?.[1];
    if (trigger?.startsWith("access_")) triggers.set(trigger, statement);
  }

  return [
    ...betaTables.map((name) => tables.get(name)).filter(isPresent),
    ...indexes.values(),
    ...triggers.values(),
  ];
}

export function buildBetaResetSql(schemaSources: string, now: number): string {
  const selected = betaSchemaStatements(schemaSources);
  if (
    !selected.some((statement) =>
      statement.includes("CREATE TABLE `access_invite_codes`"),
    ) ||
    !selected.some((statement) =>
      statement.includes("CREATE TABLE `access_invite_removals`"),
    ) ||
    !selected.some((statement) =>
      statement.includes("CREATE TRIGGER `access_allowlist_claim_invite`"),
    )
  ) {
    throw new Error("clean baseline does not contain the beta access schema");
  }

  const triggerNames = selected
    .map((statement) =>
      statement.match(/CREATE TRIGGER `([^`]+)`/u)?.[1] ?? null,
    )
    .filter((name): name is string => Boolean(name));

  const reset = [
    "PRAGMA foreign_keys = ON;",
    ...triggerNames.map((name) => `DROP TRIGGER IF EXISTS \`${name}\`;`),
    "DROP INDEX IF EXISTS `account_provider_account_uidx`;",
    "DROP INDEX IF EXISTS `account_user_github_uidx`;",
    `UPDATE agent_bootstrap_tokens
       SET revoked_at = ${now}
       WHERE revoked_at IS NULL
         AND host_id IN (
           SELECT id FROM agent_hosts WHERE organization_id IS NULL
         );`,
    `UPDATE agent_hosts
       SET disabled = 1,
           scenario_enabled = 0,
           connected = 0,
           active_session_id = NULL,
           disconnected_at = coalesce(disconnected_at, ${now}),
           updated_at = ${now}
       WHERE organization_id IS NULL;`,
    "DELETE FROM user_ssh_keys;",
    "DELETE FROM oauth_access_token;",
    "DELETE FROM oauth_refresh_token;",
    "DELETE FROM oauth_consent;",
    `DELETE FROM verification
       WHERE CASE
               WHEN json_valid(value)
               THEN json_extract(value, '$.type')
             END = 'authorization_code';`,
    `UPDATE workshop_registry_tokens
       SET revoked_at = coalesce(revoked_at, ${now});`,
    "DELETE FROM workshop_route_issuance_intents;",
    `UPDATE workshop_workspaces
       SET terminal_route_usernames_json = '[]',
           application_route_ids_json = '[]',
           updated_at = ${now};`,
    `UPDATE workshop_assist_grants
       SET terminal_route_usernames_json = '[]', updated_at = ${now};`,
    "DELETE FROM session;",
    "DROP TABLE IF EXISTS `access_events`;",
    "DROP TABLE IF EXISTS `access_allowlist`;",
    "DROP TABLE IF EXISTS `access_invite_removals`;",
    "DROP TABLE IF EXISTS `access_invite_codes`;",
    "DROP TABLE IF EXISTS `access_requests`;",
    ...selected.map((statement) => `${statement.replace(/;\s*$/u, "")};`),
    "PRAGMA foreign_key_check;",
  ];

  return `${reset.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
