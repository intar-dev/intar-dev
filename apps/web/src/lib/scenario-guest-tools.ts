import type { DesiredGuestToolsV1 } from "@/generated/bridge";
import { isRecord, normalizeSha256 } from "@/control-plane/image-registry/shared";

export type ScenarioGuestToolsChannel = "stable" | "candidate";

const TOOLS_DISK_SIZE_BYTES = 64 * 1024 * 1024;

export interface ScenarioGuestToolsPinV1 {
  schema_version: 1;
  bootstrap_abi: 1;
  tools_disk_sha256: string;
  tools_disk_size_bytes: number;
  compressed_disk_sha256: string;
  compressed_disk_size_bytes: number;
  kino_sha256: string;
  kino_size_bytes: number;
}

export function scenarioGuestToolsPinKey(
  channel: ScenarioGuestToolsChannel,
): string {
  return `guest-tools/scenario/${channel}.json`;
}

export function scenarioToolsDiskObjectKey(toolsDiskSha256: string): string {
  return `guest-tools/scenario/disks/${toolsDiskSha256}.ext4.zst`;
}

export function scenarioKinoObjectKey(kinoSha256: string): string {
  return `guest-tools/scenario/kino/${kinoSha256}/kino`;
}

export async function loadScenarioGuestToolsPin(
  env: Cloudflare.Env,
  channel: ScenarioGuestToolsChannel = "stable",
): Promise<DesiredGuestToolsV1> {
  const staticPin = (
    env as Cloudflare.Env & { SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON?: string }
  ).SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON?.trim();
  let value: unknown;
  if (staticPin) {
    try {
      value = JSON.parse(staticPin);
    } catch {
      throw new Error("static scenario guest-tools pin is invalid JSON");
    }
  } else {
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
      scenarioGuestToolsPinKey(channel),
    );
    if (!object) {
      throw new Error(`scenario guest-tools ${channel} pin is unavailable`);
    }
    try {
      value = await object.json();
    } catch {
      throw new Error(`scenario guest-tools ${channel} pin is invalid JSON`);
    }
  }
  const pin = parseScenarioGuestToolsPin(value, channel);
  const desired = desiredGuestTools(pin);
  if (staticPin) return desired;

  await verifyScenarioGuestToolsObjects(env, pin, channel);
  return desired;
}

export function parseScenarioGuestToolsPin(
  value: unknown,
  channel: ScenarioGuestToolsChannel,
): ScenarioGuestToolsPinV1 {
  if (!isRecord(value)) {
    throw new Error(`scenario guest-tools ${channel} pin is invalid`);
  }
  const toolsDiskSha256 = normalizeSha256(String(value.tools_disk_sha256 ?? ""));
  const kinoSha256 = normalizeSha256(String(value.kino_sha256 ?? ""));
  const compressedDiskSha256 = normalizeSha256(
    String(value.compressed_disk_sha256 ?? ""),
  );
  if (
    value.schema_version !== 1 ||
    !toolsDiskSha256 ||
    value.tools_disk_size_bytes !== TOOLS_DISK_SIZE_BYTES ||
    !compressedDiskSha256 ||
    typeof value.compressed_disk_size_bytes !== "number" ||
    !Number.isSafeInteger(value.compressed_disk_size_bytes) ||
    value.compressed_disk_size_bytes <= 0 ||
    !kinoSha256 ||
    typeof value.kino_size_bytes !== "number" ||
    !Number.isSafeInteger(value.kino_size_bytes) ||
    value.kino_size_bytes <= 0 ||
    value.bootstrap_abi !== 1
  ) {
    throw new Error(`scenario guest-tools ${channel} pin is invalid`);
  }

  return {
    schema_version: 1,
    bootstrap_abi: 1,
    tools_disk_sha256: toolsDiskSha256,
    tools_disk_size_bytes: TOOLS_DISK_SIZE_BYTES,
    compressed_disk_sha256: compressedDiskSha256,
    compressed_disk_size_bytes: value.compressed_disk_size_bytes,
    kino_sha256: kinoSha256,
    kino_size_bytes: value.kino_size_bytes,
  };
}

export function desiredGuestTools(
  pin: ScenarioGuestToolsPinV1,
): DesiredGuestToolsV1 {
  return {
    tools_disk_sha256: pin.tools_disk_sha256,
    tools_disk_size_bytes: pin.tools_disk_size_bytes,
    kino_sha256: pin.kino_sha256,
    bootstrap_abi: pin.bootstrap_abi,
  };
}

export async function verifyScenarioGuestToolsObjects(
  env: Cloudflare.Env,
  pin: ScenarioGuestToolsPinV1,
  channel: ScenarioGuestToolsChannel,
): Promise<void> {
  const [disk, kino] = await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      scenarioToolsDiskObjectKey(pin.tools_disk_sha256),
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.head(scenarioKinoObjectKey(pin.kino_sha256)),
  ]);
  if (
    !disk ||
    disk.size !== pin.compressed_disk_size_bytes ||
    !kino ||
    kino.size !== pin.kino_size_bytes
  ) {
    throw new Error(`scenario guest-tools ${channel} objects are unavailable`);
  }
}
