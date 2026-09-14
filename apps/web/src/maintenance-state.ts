import { WorkerEntrypoint } from "cloudflare:workers";
import { controlPlaneMaintenanceEnabled } from "@/maintenance";

export type MaintenanceFlag = "on" | "off";

export interface MaintenanceStateSnapshot {
  maintenance: MaintenanceFlag;
  observedAtMs: number;
}

/**
 * Read the live maintenance flag from the active Worker version.
 *
 * A service binding always resolves to the version that serves traffic, so the
 * image registry cleanup worker never reads a copy of the variable. That copy
 * would drift during a maintenance deployment.
 */
export function readMaintenanceStateSnapshot(
  env: Pick<Cloudflare.Env, "CONTROL_PLANE_MAINTENANCE">,
  nowMs: number,
): MaintenanceStateSnapshot {
  return {
    maintenance: controlPlaneMaintenanceEnabled(env) ? "on" : "off",
    observedAtMs: nowMs,
  };
}

/** Bound as CONTROL_PLANE by the image registry cleanup worker. */
export class MaintenanceState extends WorkerEntrypoint<Cloudflare.Env> {
  async state(): Promise<MaintenanceStateSnapshot> {
    return readMaintenanceStateSnapshot(this.env, Date.now());
  }
}
