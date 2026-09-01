import { appError } from "@/lib/app-error";

export const IMAGE_CUTOVER_GATE = "image_cutover";

export async function assertAgentKvmRunsOpen(
  database: D1Database,
  options: { allowDrainedAdminProof?: boolean } = {},
): Promise<void> {
  const gate = await database.prepare(
    "SELECT state FROM runtime_operation_gates WHERE key = ?",
  )
    .bind(IMAGE_CUTOVER_GATE)
    .first<{ state: string }>();
  if (gate?.state === "drained" && !options.allowDrainedAdminProof) {
    throw appError(
      503,
      "runtime_cutover_drained",
      "new VM runs are paused for a short runtime update",
    );
  }
}
