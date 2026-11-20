/**
 * Asks for a pass of the automatic source that owns `by`, a scope or one of
 * its scenarios: a build, a verify run or a hold of it just changed. The
 * every-minute cron runs a poked source. A manual source is left alone.
 */
export function pokeAutomaticSource(db: D1Database, by: { scopeKey: string } | { scenarioId: string }): D1PreparedStatement {
  return db.prepare(
    `UPDATE scenario_sources SET poked_at = ?1
      WHERE promotion = 'automatic' AND disconnected_at IS NULL
        AND scope_key = COALESCE(?2, (SELECT scope_key FROM scenarios WHERE id = ?3))`,
  ).bind(Date.now(), "scopeKey" in by ? by.scopeKey : null, "scenarioId" in by ? by.scenarioId : null);
}
