import {
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_PROTOCOL_VERSION,
} from "@intar/provider-contracts";
import { describe, expect, it } from "vitest";
import { assertProviderCapabilities } from "./provider-capabilities";

describe("provider capability gate", () => {
  const valid = {
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    providerKind: "gcp_compute",
    operations: PROVIDER_ADAPTER_OPERATIONS,
  } as const;

  it("accepts the exact generated contract", () => {
    expect(() => assertProviderCapabilities("gcp_compute", valid)).not.toThrow();
  });

  it("rejects a wrong service, protocol, partial operations, and extras", () => {
    expect(() =>
      assertProviderCapabilities("hetzner_cloud", valid),
    ).toThrow("kind");
    expect(() =>
      assertProviderCapabilities("gcp_compute", {
        ...valid,
        protocolVersion: 2,
      }),
    ).toThrow("protocol");
    expect(() =>
      assertProviderCapabilities("gcp_compute", {
        ...valid,
        operations: PROVIDER_ADAPTER_OPERATIONS.slice(1),
      }),
    ).toThrow("operations");
    expect(() =>
      assertProviderCapabilities("gcp_compute", {
        ...valid,
        operations: [...PROVIDER_ADAPTER_OPERATIONS, "destroyEverything"],
      }),
    ).toThrow("operations");
  });
});
