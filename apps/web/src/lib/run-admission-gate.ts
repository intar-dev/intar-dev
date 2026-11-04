import { appError } from "@/lib/app-error";

/** The operators' drain: image-ops owns it. */
export const IMAGE_CUTOVER_GATE = "image_cutover";

/** Intar's own hold while it promotes an image catalog. Only Intar writes it. */
export const PROMOTION_HOLD_GATE = "image_promotion";

/**
 * The cutover's last gate state: the operators' drain after every scenario
 * row was wiped. It holds everything `drained` holds, and also refuses
 * assignment creation and administrative proof starts, so the scenario
 * tables stay empty until the epoch migration.
 */
export const IMAGE_CUTOVER_WIPED = "wiped";

/** SQL: the cutover wipe has run; nothing may add scenario data. */
export const CUTOVER_WIPED_SQL =
  "EXISTS (SELECT 1 FROM runtime_operation_gates" +
  ` WHERE key = '${IMAGE_CUTOVER_GATE}' AND state = '${IMAGE_CUTOVER_WIPED}')`;

/** SQL: the operators' gate state `alias.state` holds new runs. */
export function cutoverDrainedSql(alias: string): string {
  return `${alias}.state IN ('drained', '${IMAGE_CUTOVER_WIPED}')`;
}

/** Whether an `image_cutover` state holds new runs. */
export function isCutoverDrained(state: string | null | undefined): boolean {
  return state === "drained" || state === IMAGE_CUTOVER_WIPED;
}

/**
 * SQL that holds while new runs must not start: an operator drain or Intar's
 * promotion hold. An administrative proof start may run under an operator
 * drain, never under the promotion hold or after the cutover wipe, so no
 * admin run can stall a swap or refill the wiped tables.
 */
export function runsHeldCondition(allowDrainedAdminProof?: boolean): string {
  const cutoverHeld = allowDrainedAdminProof
    ? `gate.state = '${IMAGE_CUTOVER_WIPED}'`
    : cutoverDrainedSql("gate");
  return (
    "EXISTS (SELECT 1 FROM runtime_operation_gates gate WHERE" +
    ` (gate.key = '${PROMOTION_HOLD_GATE}' AND gate.state = 'drained')` +
    ` OR (gate.key = '${IMAGE_CUTOVER_GATE}' AND ${cutoverHeld}))`
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

/** Refuses a write that would add scenario data after the cutover wipe. */
export async function assertCutoverNotWiped(database: D1Database): Promise<void> {
  const gate = await database
    .prepare("SELECT state FROM runtime_operation_gates WHERE key = ?")
    .bind(IMAGE_CUTOVER_GATE)
    .first<{ state: string }>();
  if (gate?.state === IMAGE_CUTOVER_WIPED) throw cutoverWipedError();
}

export function cutoverWipedError() {
  return appError(
    503,
    "runtime_cutover_wiped",
    "scenario changes are paused for the platform update",
  );
}
