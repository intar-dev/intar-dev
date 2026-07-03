const SCENARIO_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeScenarioId(value: string): boolean {
  return value !== "." && value !== ".." && SCENARIO_ID_RE.test(value);
}
