import { describe, expect, it } from "vitest";
import bundle from "./fixtures/scenario/broken-nginx-bundle.json";
import stored from "./fixtures/scenario/broken-nginx-revision.json";
import validateBridgeMessage from "./contracts/bridge-message-v9.validate";
import validateKinoConfig from "./contracts/oci-kino-config-v1.validate";
import validateMachineConfig from "./contracts/oci-machine-config-v1.validate";
import validateMachineSpec from "./contracts/machine-spec-v1.validate";
import validateManifest from "./contracts/oci-manifest-v1.validate";
import validateRevision from "./contracts/scenario-revision-v1.validate";
import validateBundleMeta from "./contracts/source-bundle-meta-v2.validate";
import validateBundle from "./contracts/source-bundle-v2.validate";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const hex = "a".repeat(64);
const hardware = {
  cloud_hypervisor_sha256: null,
  kvm: true,
  vsock: true,
  reflink: true,
  landlock: true,
  cgroup_v2: true,
  hard_cpu_quota: true,
};

// One sound document per validator.
const cases: [string, (data: unknown) => boolean, Record<string, unknown>][] = [
  ["source bundle", validateBundle, bundle],
  ["bundle meta", validateBundleMeta, { rev: "git-1-abc-pefcf1cdb" }],
  ["revision", validateRevision, JSON.parse(stored.revision.json)],
  ["learn spec", validateMachineSpec, JSON.parse(stored.specs.webserver.learn.json)],
  ["verify spec", validateMachineSpec, JSON.parse(stored.specs.webserver.verify.json)],
  [
    "manifest",
    validateManifest,
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.intar.machine.v1",
      config: { mediaType: "application/vnd.intar.machine.config.v1+json", digest: digest("c"), size: 61234 },
      layers: [{ mediaType: "application/vnd.intar.kernel.v1", digest: digest("1"), size: 11534336 }],
    },
  ],
  [
    "machine config",
    validateMachineConfig,
    {
      guest_contract: 3,
      image_format: "intar-image-3",
      build_key: digest("a"),
      boot: { cmdline: "console=hvc0" },
      disk: { size_bytes: 8589934592, chunk_size: 4194304, chunks: [[0, 2, hex]] },
    },
  ],
  ["kino config", validateKinoConfig, { guest_contract: 3, version: "1.0.0" }],
  [
    "agent hello",
    validateBridgeMessage,
    {
      type: "client_hello",
      protocol_version: 9,
      host_id: "host-1",
      agent_version: "1.0.0",
      role: "agent",
      guest_contract: 3,
      hardware,
    },
  ],
  [
    "builder hello",
    validateBridgeMessage,
    {
      type: "client_hello",
      protocol_version: 9,
      host_id: "host-1",
      agent_version: "1.0.0",
      role: "builder",
      guest_contract: 3,
      hardware,
      builder: { image_format: "intar-image-3", source_compile_digest: "pefcf1cdb" },
    },
  ],
];

describe("generated contract validators", () => {
  it.each(cases)("accept a sound %s and refuse an unknown field", (_, validate, value) => {
    expect(validate(value)).toBe(true);
    expect(validate({ ...value, later: true })).toBe(false);
  });

  it("refuse a malformed digest and an out-of-range integer", () => {
    const [, , manifest] = cases[5]!;
    expect(validateManifest({ ...manifest, config: { ...(manifest.config as object), digest: "sha256:x" } })).toBe(false);
    expect(validateKinoConfig({ guest_contract: 2 ** 32, version: "1" })).toBe(false);
    expect(validateBridgeMessage({ ...cases[8]![2], protocol_version: 8 })).toBe(false);
  });
});
