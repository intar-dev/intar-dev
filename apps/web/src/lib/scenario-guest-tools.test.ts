import { describe, expect, it } from "vitest";
import {
  SCENARIO_GUEST_TOOLS_STATIC_PIN_ENV,
  loadPublishedScenarioGuestToolsPin,
  loadScenarioGuestToolsPin,
  parseScenarioGuestToolsPin,
  readScenarioGuestToolsStaticPin,
} from "./scenario-guest-tools";

const TOOLS_DISK_SHA256 = "1".repeat(64);
const COMPRESSED_DISK_SHA256 = "3".repeat(64);
const KINO_SHA256 = "2".repeat(64);

const PIN_JSON = JSON.stringify({
  schema_version: 1,
  bootstrap_abi: 2,
  tools_disk_sha256: TOOLS_DISK_SHA256,
  tools_disk_size_bytes: 67108864,
  compressed_disk_sha256: COMPRESSED_DISK_SHA256,
  compressed_disk_size_bytes: 1048576,
  kino_sha256: KINO_SHA256,
  kino_size_bytes: 4096,
});

function runtimeEnv(pin: string | undefined): Cloudflare.Env {
  return {
    SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON: pin,
    // The runtime has no R2 fallback: any bucket access is a bug.
    VM_IMAGE_REGISTRY_BUCKET: {
      get: () => {
        throw new Error("runtime must not read the guest-tools bucket");
      },
      head: () => {
        throw new Error("runtime must not read the guest-tools bucket");
      },
    },
  } as unknown as Cloudflare.Env;
}

describe("scenario guest-tools static pin", () => {
  it("returns the pinned ABI 2 tools without any R2 call", () => {
    const desired = loadScenarioGuestToolsPin(runtimeEnv(PIN_JSON));

    expect(desired).toEqual({
      tools_disk_sha256: TOOLS_DISK_SHA256,
      tools_disk_size_bytes: 67108864,
      kino_sha256: KINO_SHA256,
      bootstrap_abi: 2,
    });
  });

  it("reads the pin again for a second caller without R2", () => {
    const env = runtimeEnv(PIN_JSON);

    expect(readScenarioGuestToolsStaticPin(env).bootstrap_abi).toBe(2);
    expect(loadScenarioGuestToolsPin(env).tools_disk_sha256).toBe(
      TOOLS_DISK_SHA256,
    );
  });

  it("fails closed with a configuration error when the pin is missing", () => {
    for (const missing of [undefined, "", "   "]) {
      expect(() => loadScenarioGuestToolsPin(runtimeEnv(missing))).toThrow(
        new RegExp(SCENARIO_GUEST_TOOLS_STATIC_PIN_ENV + " is not configured"),
      );
    }
  });

  it("fails closed when the pin is not valid JSON", () => {
    expect(() => loadScenarioGuestToolsPin(runtimeEnv("not json"))).toThrow(
      /is not valid JSON/,
    );
  });

  it("rejects an ABI 1 pin", () => {
    const value = { ...JSON.parse(PIN_JSON), bootstrap_abi: 1 };

    expect(() => parseScenarioGuestToolsPin(value, "static")).toThrow(
      /bootstrap_abi must be 2, got 1/,
    );
  });

  it("rejects an unsupported schema version", () => {
    const value = { ...JSON.parse(PIN_JSON), schema_version: 2 };

    expect(() => parseScenarioGuestToolsPin(value, "static")).toThrow(
      /schema_version must be 1, got 2/,
    );
  });

  it("rejects a manifest with unknown keys", () => {
    const value = { ...JSON.parse(PIN_JSON), compressed_disk_path: "/tmp/x" };

    expect(() => parseScenarioGuestToolsPin(value, "static")).toThrow(
      /unknown keys compressed_disk_path/,
    );
  });

  it("rejects malformed digests and sizes", () => {
    expect(() =>
      parseScenarioGuestToolsPin(
        { ...JSON.parse(PIN_JSON), kino_sha256: "abc" },
        "static",
      ),
    ).toThrow(/every digest must be 64 lowercase hexadecimal characters/);
    expect(() =>
      parseScenarioGuestToolsPin(
        { ...JSON.parse(PIN_JSON), tools_disk_size_bytes: 1 },
        "static",
      ),
    ).toThrow(/tools_disk_size_bytes must be 67108864, got 1/);
    expect(() =>
      parseScenarioGuestToolsPin(
        { ...JSON.parse(PIN_JSON), compressed_disk_size_bytes: 0 },
        "static",
      ),
    ).toThrow(/compressed_disk_size_bytes must be a positive integer/);
  });

  it("accepts a pin value with surrounding whitespace", () => {
    const desired = loadScenarioGuestToolsPin(runtimeEnv("  " + PIN_JSON + "\n"));

    expect(desired.bootstrap_abi).toBe(2);
  });
});

describe("published scenario guest-tools channel", () => {
  it("still reads and verifies the dynamic channel pin for the publish path", async () => {
    const env = {
      VM_IMAGE_REGISTRY_BUCKET: {
        get: async () => ({ json: async () => JSON.parse(PIN_JSON) }),
        head: async (key: string) => ({
          size: key.includes("/kino/") ? 4096 : 1048576,
        }),
      },
    } as unknown as Cloudflare.Env;

    await expect(
      loadPublishedScenarioGuestToolsPin(env, "candidate"),
    ).resolves.toEqual({
      tools_disk_sha256: TOOLS_DISK_SHA256,
      tools_disk_size_bytes: 67108864,
      kino_sha256: KINO_SHA256,
      bootstrap_abi: 2,
    });
  });

  it("reports a missing published pin", async () => {
    const env = {
      VM_IMAGE_REGISTRY_BUCKET: { get: async () => null, head: async () => null },
    } as unknown as Cloudflare.Env;

    await expect(
      loadPublishedScenarioGuestToolsPin(env, "stable"),
    ).rejects.toThrow(/stable pin is unavailable/);
  });

  it("reports a published object size mismatch", async () => {
    const env = {
      VM_IMAGE_REGISTRY_BUCKET: {
        get: async () => ({ json: async () => JSON.parse(PIN_JSON) }),
        head: async () => ({ size: 1 }),
      },
    } as unknown as Cloudflare.Env;

    await expect(
      loadPublishedScenarioGuestToolsPin(env, "candidate"),
    ).rejects.toThrow(/candidate objects are unavailable/);
  });
});
