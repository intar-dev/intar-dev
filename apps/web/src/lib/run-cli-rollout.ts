/**
 * The learner CLI is delivered in images as well as in the control plane. Keep
 * host capability enforcement off until the new images and host agents are
 * ready, then enable it in a final configuration-only deployment.
 */
export function learnerRunCliV1EnforcementEnabled(environment: {
  LEARNER_RUN_CLI_V1_ENFORCEMENT?: unknown;
}): boolean {
  return String(environment.LEARNER_RUN_CLI_V1_ENFORCEMENT) === "on";
}
