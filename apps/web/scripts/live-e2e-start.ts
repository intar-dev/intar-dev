export interface ScenarioStartRequest {
  path: string;
  init: {
    method: "POST";
    json?: { hostId: string };
  };
}

export function scenarioStartRequest(
  scenarioId: string,
  hostId: string | null,
): ScenarioStartRequest {
  return {
    path: `/api/scenarios/${encodeURIComponent(scenarioId)}/start`,
    init: {
      method: "POST",
      ...(hostId ? { json: { hostId } } : {}),
    },
  };
}
