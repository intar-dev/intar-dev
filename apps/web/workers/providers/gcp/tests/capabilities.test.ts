import { describe, expect, it } from "vitest";
import { assertProviderCapabilities } from "@intar/provider-testkit";
import { GCP_PROVIDER_CAPABILITIES } from "../src/capabilities";

describe("GCP provider capabilities", () => {
  it("conforms to protocol version 1", () => {
    expect(() =>
      assertProviderCapabilities(GCP_PROVIDER_CAPABILITIES, "gcp_compute"),
    ).not.toThrow();
  });
});
