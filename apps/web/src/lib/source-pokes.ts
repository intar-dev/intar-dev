/**
 * Asks for a pass of the source that owns `by`, a scope or one of its
 * scenarios: a build or a verify run of it just changed. The
 * every-minute cron runs a poked source.
 */
export function pokeSource(db: D1Database, by: { scopeKey: string } | { scenarioId: string }): D1PreparedStatement {
  return db.prepare(
    `UPDATE scenario_sources SET poked_at = ?1
      WHERE disconnected_at IS NULL
        AND scope_key = COALESCE(?2, (SELECT scope_key FROM scenarios WHERE id = ?3))`,
  ).bind(Date.now(), "scopeKey" in by ? by.scopeKey : null, "scenarioId" in by ? by.scenarioId : null);
}
