import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, courseCatalogs, hostActualState, member } from "@/db/schema";
import { seedScenarioRow, stateReport } from "@/control-plane/host-runtime-do/test-fixtures";
import type { AdmissionHostReadiness } from "./admission-guards";

/** The scenario the admission fixture links and its runs start. */
export const ADMISSION_SCENARIO_ID = "intar/scenario-one";

/** Current access and readiness for tests that invoke the batch directly. */
export async function seedAdmissionGuardFixture(input: {
  userId: string;
  organizationId: string;
  hostId: string;
}): Promise<AdmissionHostReadiness> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const message = stateReport(input.hostId, {
    observedAt: now,
    appliedDesiredVersion: 0,
    cachedImages: [{
      image: `sha256:${"2".repeat(64)}`,
      phase: "ready",
      updated_at_unix_ms: now,
    }],
  });
  if (message.type !== "state_report") throw new Error("state report fixture missing");
  await db.update(agentHosts).set({
    activeSessionId: "admission-session",
    credentialGeneration: 1,
    lastHeartbeatAt: now,
  }).where(eq(agentHosts.id, input.hostId));
  await db.insert(hostActualState).values({
    hostId: input.hostId,
    appliedDesiredVersion: 0,
    observedAt: now,
    reportJson: message.report,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(member).values({
    id: "admission-membership",
    organizationId: input.organizationId,
    userId: input.userId,
    role: "member",
    createdAt: new Date(now),
  });
  await seedScenarioRow(db, ADMISSION_SCENARIO_ID, input.organizationId);
  await db.insert(courseCatalogs).values({
    scopeKey: "organization:" + input.organizationId,
    organizationId: input.organizationId,
    sourceRevision: "admission-fixture",
    catalogJson: {
      version: 2,
      courses: [{
        courseId: "linux-operations",
        title: "Linux operations",
        summary: "Linux operations",
        bodyMarkdown: "Linux operations",
        sequential: true,
        lectures: [{
          lectureId: "01-repair-nginx",
          title: "Repair nginx",
          summary: "Learn the nginx service model.",
          bodyMarkdown: "# Theory",
          category: "linux",
          tags: [],
          estimatedMinutes: 30,
          scenarioId: ADMISSION_SCENARIO_ID,
        }],
      }],
    },
  });
  return {
    credentialGeneration: 1,
    activeSessionId: "admission-session",
    actualReportedAt: now,
    actualReportText: JSON.stringify(message.report),
  };
}
