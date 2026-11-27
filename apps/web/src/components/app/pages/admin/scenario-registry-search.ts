/** `?course=` opens one course's scenarios in the registry. */
export function validateScenarioRegistrySearch(search: Record<string, unknown>): { course?: string } {
  return typeof search.course === "string" && search.course ? { course: search.course } : {};
}
