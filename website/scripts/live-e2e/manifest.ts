import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScenarioManifestV3 } from "../../src/generated/catalog";
import type { LoadedManifest } from "./types";
import { isImageArchitecture, isSha256Hex } from "./options";
import { bootArtifactSha256s, isRecord, sha256FileHex } from "./utils";

export async function loadManifests(
  paths: string[],
): Promise<LoadedManifest[]> {
  const loaded: LoadedManifest[] = [];
  for (const path of paths) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    loaded.push({ path, manifest: parseManifest(parsed, path) });
  }
  return loaded;
}

export function parseManifest(
  value: unknown,
  path: string,
): ScenarioManifestV3 {
  if (!isRecord(value)) {
    throw new Error(`manifest ${path} is not a JSON object`);
  }
  if (value.schema_version !== 3) {
    throw new Error(`manifest ${path} must use schema_version 3`);
  }
  if (typeof value.scenario_id !== "string" || !value.scenario_id) {
    throw new Error(`manifest ${path} is missing scenario_id`);
  }
  if (!Array.isArray(value.vms) || value.vms.length === 0) {
    throw new Error(`manifest ${path} must contain at least one VM`);
  }
  value.vms.forEach((vm, index) =>
    assertManifestVmDirectBootMetadata(vm, path, index),
  );
  return value as unknown as ScenarioManifestV3;
}

export function assertManifestVmDirectBootMetadata(
  value: unknown,
  path: string,
  index: number,
): void {
  if (!isRecord(value)) {
    throw new Error(`manifest ${path} VM ${index} is not an object`);
  }
  const name =
    typeof value.name === "string" && value.name ? value.name : index;
  if (value.image_format !== "raw_zstd") {
    throw new Error(
      `manifest ${path} VM ${name} must use image_format raw_zstd`,
    );
  }
  const virtualSize = value.image_virtual_size_bytes;
  if (!Number.isSafeInteger(virtualSize) || Number(virtualSize) <= 0) {
    throw new Error(
      `manifest ${path} VM ${name} has invalid image_virtual_size_bytes`,
    );
  }
  if (
    typeof value.image_sha256 !== "string" ||
    !isSha256Hex(value.image_sha256)
  ) {
    throw new Error(`manifest ${path} VM ${name} has invalid image_sha256`);
  }
  if (!isRecord(value.image_key)) {
    throw new Error(`manifest ${path} VM ${name} is missing image_key`);
  }
  if (!isImageArchitecture(value.image_key.arch)) {
    throw new Error(`manifest ${path} VM ${name} has invalid image_key.arch`);
  }
  if (!isRecord(value.boot)) {
    throw new Error(`manifest ${path} VM ${name} is missing boot metadata`);
  }
  if (
    typeof value.boot.kernel_sha256 !== "string" ||
    !isSha256Hex(value.boot.kernel_sha256)
  ) {
    throw new Error(`manifest ${path} VM ${name} has invalid kernel_sha256`);
  }
  if (
    typeof value.boot.initrd_sha256 !== "string" ||
    !isSha256Hex(value.boot.initrd_sha256)
  ) {
    throw new Error(`manifest ${path} VM ${name} has invalid initrd_sha256`);
  }
  if (
    typeof value.boot.cmdline !== "string" ||
    !value.boot.cmdline.includes("root=/dev/vda")
  ) {
    throw new Error(
      `manifest ${path} VM ${name} boot cmdline does not direct-boot /dev/vda`,
    );
  }
}

export function combineManifests(loaded: LoadedManifest[]): ScenarioManifestV3 {
  const [first, ...rest] = loaded;
  if (!first) {
    throw new Error("cannot combine zero manifests");
  }
  const combined: ScenarioManifestV3 = {
    ...first.manifest,
    vms: [...first.manifest.vms],
  };
  const seenVmNames = new Set(combined.vms.map((vm) => vm.name));

  for (const next of rest) {
    const nextHeader = { ...next.manifest, vms: [] };
    const combinedHeader = { ...combined, vms: [] };
    if (JSON.stringify(nextHeader) !== JSON.stringify(combinedHeader)) {
      throw new Error("cannot combine manifests for different scenarios");
    }
    for (const vm of next.manifest.vms) {
      if (seenVmNames.has(vm.name)) {
        throw new Error(`duplicate VM manifest name ${vm.name}`);
      }
      seenVmNames.add(vm.name);
      combined.vms.push(vm);
    }
  }

  return combined;
}

export function inferImagePaths(loaded: LoadedManifest[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const item of loaded) {
    const [vm] = item.manifest.vms;
    if (item.manifest.vms.length === 1 && vm) {
      images.set(vm.name, stripManifestSuffix(item.path));
    }
  }
  return images;
}

export async function inferArtifactPaths(
  loaded: LoadedManifest[],
  manifest: ScenarioManifestV3,
): Promise<Map<string, string>> {
  const required = new Set(bootArtifactSha256s(manifest));
  const inferred = new Map<string, string>();
  const dirs = new Set<string>();
  for (const item of loaded) {
    const dir = dirname(item.path);
    dirs.add(dir);
    dirs.add(join(dir, "base-images"));
  }

  for (const dir of dirs) {
    for (const path of await listCandidateArtifactFiles(dir)) {
      if (inferred.size === required.size) return inferred;
      const sha256 = await sha256FileHex(path);
      if (required.has(sha256) && !inferred.has(sha256)) {
        inferred.set(sha256, path);
      }
    }
  }
  return inferred;
}

export async function listCandidateArtifactFiles(
  dir: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.includes("vmlinuz") ||
        name.includes("initrd") ||
        name.endsWith(".artifact"),
    )
    .map((name) => join(dir, name));
}

export function stripManifestSuffix(path: string): string {
  return path.endsWith(".manifest.json")
    ? path.slice(0, -".manifest.json".length)
    : path;
}
