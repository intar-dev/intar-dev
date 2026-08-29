import { ApiClient } from "./live-e2e/api-client";
import {
  DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION,
  verifyWorkshopRunCliViaNativeSsh,
} from "./live-e2e/workshop-run-cli";

const baseUrl = process.env.INTAR_LIVE_BASE_URL?.trim() ?? "";
const cookie = process.env.INTAR_LIVE_COOKIE?.trim() ?? "";
const facilitatorCookie =
  process.env.INTAR_LIVE_WORKSHOP_FACILITATOR_COOKIE?.trim() ?? "";
const sessionId = process.env.INTAR_LIVE_WORKSHOP_SESSION_ID?.trim() ?? "";
const provider = process.env.INTAR_LIVE_WORKSHOP_PROVIDER?.trim() ?? "";
const teardownConfirmation =
  process.env.INTAR_LIVE_WORKSHOP_TEARDOWN_CONFIRMATION?.trim() ?? "";

if (
  !baseUrl ||
  !cookie ||
  !facilitatorCookie ||
  !sessionId ||
  !isProvider(provider) ||
  teardownConfirmation !== DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION
) {
  throw new Error(
    "set INTAR_LIVE_BASE_URL, INTAR_LIVE_COOKIE (participant), INTAR_LIVE_WORKSHOP_FACILITATOR_COOKIE, INTAR_LIVE_WORKSHOP_SESSION_ID, INTAR_LIVE_WORKSHOP_PROVIDER=kvm|direct-cloud, and INTAR_LIVE_WORKSHOP_TEARDOWN_CONFIRMATION=END DISPOSABLE WORKSHOP",
  );
}

await verifyWorkshopRunCliViaNativeSsh({
  client: new ApiClient(baseUrl, cookie),
  facilitatorClient: new ApiClient(baseUrl, facilitatorCookie),
  sessionId,
  providerLabel: provider,
  disposableConfirmation: teardownConfirmation,
});

console.log(
  `[live-e2e] ${provider} workshop native SSH run CLI action proof passed`,
);

function isProvider(value: string): value is "kvm" | "direct-cloud" {
  return value === "kvm" || value === "direct-cloud";
}
