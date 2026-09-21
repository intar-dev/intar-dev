import { HOST_DEGRADED_AFTER_MS } from "@/lib/host-health";
import { HOST_HEARTBEAT_TTL_MS } from "./start";

export interface AdmissionHostReadiness {
  credentialGeneration: number;
  activeSessionId: string;
  actualReportedAt: number;
  actualReportText: string;
}

export interface AdmissionContentAccess {
  userId: string;
  organizationId: string | null;
  scenarioId: string;
  courseScopeKey: string | null;
  courseId: string | null;
  lectureId: string | null;
  allowSequenceBypass: boolean;
  requiresAdmin: boolean;
}

/** The snapshot was validated after reading the desired-state CAS version. */
export function admissionHostReadinessCondition(parameter: number): string {
  const field = (name: string) => `json_extract(?${parameter}, '$.${name}')`;
  // Use the database clock: a prepared batch can wait past the readiness TTL.
  const now = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
  return `host.connected = 1
    AND host.active_session_id = ${field("activeSessionId")}
    AND host.credential_generation = ${field("credentialGeneration")}
    AND host.last_heartbeat_at >= ${now} - ${HOST_HEARTBEAT_TTL_MS}
    AND EXISTS (SELECT 1 FROM host_actual_state actual
      WHERE actual.host_id = host.id
        AND actual.updated_at = ${field("actualReportedAt")}
        AND actual.updated_at >= ${now} - ${HOST_DEGRADED_AFTER_MS}
        AND actual.report_json = ${field("actualReportText")}
        AND (host.scope = 'platform' OR json_extract(actual.report_json, '$.relay_connected') = 1))`;
}

export { admissionContentAccessCondition, currentScenarioRunContentAccessCondition } from "./content-access";
