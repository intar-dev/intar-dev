import { OCI_MANIFEST_MEDIA_TYPE } from "./push";

const encoder = new TextEncoder();

export interface PushedBlob {
  bytes: Uint8Array<ArrayBuffer>;
  digest: string;
  hex: string;
}

export async function blob(content: string | Uint8Array<ArrayBuffer>): Promise<PushedBlob> {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes, digest: `sha256:${hex}`, hex };
}

export function machineConfig(buildKey: string, overrides: Record<string, unknown> = {}) {
  return {
    guest_contract: 3,
    image_format: "intar-image-3",
    build_key: buildKey,
    boot: { cmdline: "console=hvc0" },
    disk: { size_bytes: 4194304, chunk_size: 4194304, chunks: [[0, 1, "a".repeat(64)]] },
    ...overrides,
  };
}

export function manifestOf(artifactType: string, config: PushedBlob, configMediaType: string, layers: Array<[string, PushedBlob]>) {
  return {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType,
    config: { mediaType: configMediaType, digest: config.digest, size: config.bytes.length },
    layers: layers.map(([mediaType, layer]) => ({ mediaType, digest: layer.digest, size: layer.bytes.length })),
  };
}
