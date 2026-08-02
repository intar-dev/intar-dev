import { describe, expect, it } from "vitest";
import { assertProviderCapabilities } from "@intar/provider-testkit";
import { HETZNER_PROVIDER_CAPABILITIES } from "../src/capabilities";

describe("Hetzner provider capabilities", () => {
  it("conforms to protocol version 1", () => {
    expect(() =>
      assertProviderCapabilities(HETZNER_PROVIDER_CAPABILITIES, "hetzner_cloud"),
    ).not.toThrow();
  });
});
