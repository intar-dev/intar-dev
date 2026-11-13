const SCENARIO_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeScenarioId(value: string): boolean {
  return value !== "." && value !== ".." && SCENARIO_ID_RE.test(value);
}

/** `<namespace>/<slug>`: the id of a scenario on the revision model. */
const REVISION_SCENARIO_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?\/[a-z0-9][a-z0-9-]{2,62}$/;

export function isRevisionScenarioId(value: string): boolean {
  return REVISION_SCENARIO_ID_RE.test(value);
}
