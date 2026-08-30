import { beforeEach } from "vitest";
import { env } from "cloudflare:workers";

const toolsDiskSha256 = "1".repeat(64);
const kinoSha256 = "2".repeat(64);

beforeEach(async () => {
  await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `guest-tools/scenario/disks/${toolsDiskSha256}.ext4.zst`,
      new Uint8Array([1]),
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `guest-tools/scenario/kino/${kinoSha256}/kino`,
      new Uint8Array([2]),
    ),
  ]);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "guest-tools/scenario/stable.json",
    JSON.stringify({
      schema_version: 1,
      bootstrap_abi: 1,
      tools_disk_sha256: toolsDiskSha256,
      tools_disk_size_bytes: 64 * 1024 * 1024,
      compressed_disk_sha256: "3".repeat(64),
      compressed_disk_size_bytes: 1,
      kino_sha256: kinoSha256,
      kino_size_bytes: 1,
    }),
  );
});
