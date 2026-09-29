import { appError } from "@/lib/app-error";

/** The operators' drain: image-ops and the metal release scripts own it. */
export const IMAGE_CUTOVER_GATE = "image_cutover";

/** Intar's own hold while it promotes an image catalog. Only Intar writes it. */
export const PROMOTION_HOLD_GATE = "image_promotion";

/**
 * SQL that holds while new runs must not start: an operator drain or Intar's
 * promotion hold. An administrative proof start may run under an operator
 * drain, never under the promotion hold, so no admin run can stall a swap.
 */
export function runsHeldCondition(allowDrainedAdminProof?: boolean): string {
  const keys = allowDrainedAdminProof
    ? `'${PROMOTION_HOLD_GATE}'`
    : `'${IMAGE_CUTOVER_GATE}', '${PROMOTION_HOLD_GATE}'`;
  return (
    "EXISTS (SELECT 1 FROM runtime_operation_gates gate" +
    ` WHERE gate.key IN (${keys}) AND gate.state = 'drained')`
  );
}

export async function assertAgentKvmRunsOpen(
  database: D1Database,
  options: { allowDrainedAdminProof?: boolean } = {},
): Promise<void> {
  const row = await database
    .prepare(`SELECT ${runsHeldCondition(options.allowDrainedAdminProof)} AS held`)
    .first<{ held: number }>();
  if (row?.held) {
    throw appError(
      503,
      "runtime_cutover_drained",
      "new VM runs are paused for a short runtime update",
    );
  }
}

/** Whether Intar holds new runs for an image promotion. */
export async function promotionHoldActive(database: D1Database): Promise<boolean> {
  const gate = await database
    .prepare("SELECT state FROM runtime_operation_gates WHERE key = ?")
    .bind(PROMOTION_HOLD_GATE)
    .first<{ state: string }>();
  return gate?.state === "drained";
}
