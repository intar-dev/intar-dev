import { describe, expect, it } from "vitest";
import bundle from "./fixtures/scenario/broken-nginx-bundle.json";
import validateBridgeMessage from "./contracts/bridge-message-v9.validate";
import validateBundle from "./contracts/source-bundle-v2.validate";

// workerd refuses code generation from strings, so this proves the
// validators need none.
describe("generated contract validators in a Worker", () => {
  it("validate without a runtime compile", () => {
    expect(validateBundle(bundle)).toBe(true);
    expect(validateBundle({ ...bundle, later: true })).toBe(false);
    expect(validateBridgeMessage({ type: "sync_request", protocol_version: 9, host_id: "h", reason: "connect" })).toBe(true);
  });
});
