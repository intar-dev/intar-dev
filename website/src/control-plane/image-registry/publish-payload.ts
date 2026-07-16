import {
  type ScenarioHintManifestV3,
  type ScenarioManifestV3,
  type ScenarioProbeManifestV3,
  type ScenarioVmManifestV3,
} from "@/generated/catalog";
import { bootArtifactObjectMatchesSha, imageObjectMatchesSha } from "./agent";
import {
  bootArtifactSha256s,
  artifactObjectKey,
  jsonResponse,
  sha256Hex,
  registryImageKey,
  normalizeSha256,
  imageObjectKey,
  textEncoder,
  isRecord,
  isSafeRegistrySlug,
  isImageKey,
  readString,
  isScenarioDifficulty,
  isPositiveU32,
  isPositiveU16,
  isProbePhase,
  isOptionalString,
  artifactFilenameMatches,
} from "./shared";

export type PreparedBootArtifact = {
  sha256: string;
  objectKey: string;
  bytes: number;
  reused: boolean;
  payload: ArrayBuffer | null;
};

export type PublishedBootArtifact = {
  sha256: string;
  object_key: string;
  bytes: number;
  reused: boolean;
};

export type PreparedVmImage = {
  vmName: string;
  imageKey: string;
  imageSha256: string;
  objectKey: string;
  bytes: number;
  reused: boolean;
  payload: ArrayBuffer | null;
};

export type PublishedVmImage = {
  image_key: string;
  image_sha256: string;
  object_key: string;
  bytes: number;
  reused: boolean;
};

export async function prepareBootArtifacts(
  env: Cloudflare.Env,
  form: FormData,
  manifest: ScenarioManifestV3,
): Promise<
  | {
      ok: true;
      prepared: PreparedBootArtifact[];
      uploaded: PublishedBootArtifact[];
    }
  | { ok: false; response: Response }
> {
  const prepared: PreparedBootArtifact[] = [];
  const uploaded = [];
  for (const sha256 of bootArtifactSha256s(manifest)) {
    const objectKey = artifactObjectKey(sha256);
    const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
    if (bootArtifactObjectMatchesSha(existing, sha256)) {
      prepared.push({
        sha256,
        objectKey,
        bytes: existing.size,
        reused: true,
        payload: null,
      });
      uploaded.push({
        sha256,
        object_key: objectKey,
        bytes: existing.size,
        reused: true,
      });
      continue;
    }

    const file = artifactFileForSha(form, sha256);
    if (!file) {
      return {
        ok: false,
        response: jsonResponse(
          { error: `missing boot artifact ${sha256}` },
          400,
        ),
      };
    }

    const payload = await file.arrayBuffer();
    const actualSha256 = await sha256Hex(payload);
    if (actualSha256 !== sha256) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: "boot artifact sha256 mismatch",
            expected: sha256,
            actual: actualSha256,
          },
          422,
        ),
      };
    }

    prepared.push({
      sha256,
      objectKey,
      bytes: payload.byteLength,
      reused: false,
      payload,
    });
    uploaded.push({
      sha256,
      object_key: objectKey,
      bytes: payload.byteLength,
      reused: false,
    });
  }

  return { ok: true, prepared, uploaded };
}

export async function prepareVmImages(
  env: Cloudflare.Env,
  form: FormData,
  manifest: ScenarioManifestV3,
): Promise<
  { ok: true; prepared: PreparedVmImage[] } | { ok: false; response: Response }
> {
  const prepared: PreparedVmImage[] = [];
  for (const vm of manifest.vms) {
    const imageKey = registryImageKey(vm.image_key);
    const expectedSha256 = normalizeSha256(vm.image_sha256);
    if (!expectedSha256) {
      return {
        ok: false,
        response: jsonResponse(
          { error: `invalid image_sha256 for vm ${vm.name}` },
          400,
        ),
      };
    }

    const objectKey = imageObjectKey(imageKey, expectedSha256);
    const file = imageFileForVm(form, vm);
    if (!file) {
      // Large images are uploaded ahead of publish via /registry/v1/uploads;
      // accept the manifest when the content-addressed object already exists.
      const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
      if (imageObjectMatchesSha(existing, imageKey, expectedSha256)) {
        prepared.push({
          vmName: vm.name.trim(),
          imageKey,
          imageSha256: expectedSha256,
          objectKey,
          bytes: existing.size,
          reused: true,
          payload: null,
        });
        continue;
      }
      return {
        ok: false,
        response: jsonResponse(
          {
            error: `missing image for vm ${vm.name}: attach it to the form or upload it via /registry/v1/uploads first`,
          },
          400,
        ),
      };
    }

    const payload = await file.arrayBuffer();
    const actualSha256 = await sha256Hex(payload);
    if (actualSha256 !== expectedSha256) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: `sha256 mismatch for vm ${vm.name}`,
            expected: expectedSha256,
            actual: actualSha256,
          },
          422,
        ),
      };
    }

    prepared.push({
      vmName: vm.name.trim(),
      imageKey,
      imageSha256: expectedSha256,
      objectKey,
      bytes: payload.byteLength,
      reused: false,
      payload,
    });
  }
  return { ok: true, prepared };
}

export async function storePreparedBootArtifacts(
  env: Cloudflare.Env,
  artifacts: PreparedBootArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.reused || !artifact.payload) {
      continue;
    }
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      artifact.objectKey,
      artifact.payload,
      {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { artifact_sha256: artifact.sha256 },
      },
    );
  }
}

export async function storePreparedVmImages(
  env: Cloudflare.Env,
  images: PreparedVmImage[],
  scenarioId: string,
): Promise<PublishedVmImage[]> {
  const uploaded: PublishedVmImage[] = [];
  for (const image of images) {
    if (image.payload) {
      await env.VM_IMAGE_REGISTRY_BUCKET.put(image.objectKey, image.payload, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          image_key: image.imageKey,
          image_sha256: image.imageSha256,
          scenario_id: scenarioId,
          vm_name: image.vmName,
        },
      });
    }
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      `${image.objectKey}.sha256`,
      textEncoder.encode(`${image.imageSha256}  ${image.imageKey}.raw.zst\n`),
      { httpMetadata: { contentType: "text/plain; charset=utf-8" } },
    );
    uploaded.push({
      image_key: image.imageKey,
      image_sha256: image.imageSha256,
      object_key: image.objectKey,
      bytes: image.bytes,
      reused: image.reused,
    });
  }
  return uploaded;
}

export async function readManifest(
  value: FormDataEntryValue | null,
): Promise<
  { ok: true; value: ScenarioManifestV3 } | { ok: false; response: Response }
> {
  if (!value) {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest form field is required" }, 400),
    };
  }

  const raw = typeof value === "string" ? value : await value.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest is not valid JSON" }, 400),
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest is not a JSON object" }, 400),
    };
  }
  return { ok: true, value: parsed as unknown as ScenarioManifestV3 };
}

export function validateManifest(
  manifest: ScenarioManifestV3,
): Response | null {
  if (manifest.schema_version !== 3) {
    return jsonResponse({ error: "manifest schema_version must be 3" }, 400);
  }
  const scenarioId = manifest.scenario_id?.trim();
  if (!scenarioId) {
    return jsonResponse({ error: "manifest scenario_id is required" }, 400);
  }
  if (!isSafeRegistrySlug(scenarioId)) {
    return jsonResponse({ error: "manifest scenario_id is invalid" }, 400);
  }
  if (!hasValidScenarioMetadata(manifest, scenarioId)) {
    return jsonResponse(
      { error: "manifest contains invalid scenario metadata" },
      400,
    );
  }
  if (!hasValidHintList(manifest.hints)) {
    return jsonResponse(
      { error: "manifest contains invalid scenario hints" },
      400,
    );
  }
  if (!Array.isArray(manifest.vms) || manifest.vms.length === 0) {
    return jsonResponse(
      { error: "manifest must contain at least one vm" },
      400,
    );
  }
  const vmNames = new Set<string>();
  const imageKeys = new Set<string>();
  for (const vm of manifest.vms) {
    const vmName = vm.name?.trim();
    if (!vmName || !isSafeRegistrySlug(vmName) || !isImageKey(vm.image_key)) {
      return jsonResponse({ error: "manifest contains an invalid vm" }, 400);
    }
    if (!hasValidVmResources(vm)) {
      return jsonResponse(
        { error: "manifest contains invalid vm resources" },
        400,
      );
    }
    if (vmNames.has(vmName)) {
      return jsonResponse(
        { error: "manifest contains duplicate vm names" },
        400,
      );
    }
    vmNames.add(vmName);
    if (vm.image_key.scenario !== scenarioId || vm.image_key.vm !== vmName) {
      return jsonResponse(
        { error: "manifest image key must match scenario and vm names" },
        400,
      );
    }
    if (!normalizeSha256(vm.image_sha256)) {
      return jsonResponse(
        { error: "manifest contains invalid image sha256" },
        400,
      );
    }
    const imageKey = registryImageKey(vm.image_key);
    if (imageKeys.has(imageKey)) {
      return jsonResponse(
        { error: "manifest contains duplicate image keys" },
        400,
      );
    }
    imageKeys.add(imageKey);
    const kernelSha256 = normalizeSha256(vm.boot?.kernel_sha256 ?? "");
    const initrdSha256 = normalizeSha256(vm.boot?.initrd_sha256 ?? "");
    const bootCmdline = vm.boot?.cmdline?.trim() ?? "";
    if (
      vm.image_format !== "raw_zstd" ||
      typeof vm.image_virtual_size_bytes !== "number" ||
      !Number.isSafeInteger(vm.image_virtual_size_bytes) ||
      vm.image_virtual_size_bytes <= 0 ||
      !kernelSha256 ||
      !initrdSha256 ||
      !isDirectBootCmdline(bootCmdline)
    ) {
      return jsonResponse(
        { error: "manifest contains invalid boot metadata" },
        400,
      );
    }
    const probeError = validateVmProbes(vm.probes);
    if (probeError) {
      return probeError;
    }
  }
  return null;
}

export function isDirectBootCmdline(value: string): boolean {
  return value.split(/\s+/).includes("root=/dev/vda");
}

export function normalizePublishManifest(
  manifest: ScenarioManifestV3,
): ScenarioManifestV3 {
  const scenarioId = manifest.scenario_id.trim();
  return {
    ...manifest,
    scenario_id: scenarioId,
    name: scenarioId,
    vms: manifest.vms.map((vm) => {
      const vmName = vm.name.trim();
      return {
        ...vm,
        name: vmName,
        image_key: {
          ...vm.image_key,
          scenario: scenarioId,
          vm: vmName,
        },
        image_sha256: normalizeSha256(vm.image_sha256) ?? vm.image_sha256,
        boot: {
          ...vm.boot,
          kernel_sha256:
            normalizeSha256(vm.boot.kernel_sha256) ?? vm.boot.kernel_sha256,
          initrd_sha256:
            normalizeSha256(vm.boot.initrd_sha256) ?? vm.boot.initrd_sha256,
          cmdline: vm.boot.cmdline.trim(),
        },
      };
    }),
  };
}

export function hasValidScenarioMetadata(
  manifest: ScenarioManifestV3,
  scenarioId: string,
): boolean {
  return (
    readString(manifest.name) === scenarioId &&
    Boolean(readString(manifest.title)) &&
    Boolean(readString(manifest.description)) &&
    isScenarioDifficulty(manifest.difficulty) &&
    isPositiveU32(manifest.estimated_minutes) &&
    Array.isArray(manifest.tags) &&
    manifest.tags.every((tag) => Boolean(readString(tag))) &&
    Boolean(readString(manifest.briefing_markdown)) &&
    Boolean(readString(manifest.solution_markdown))
  );
}

export function hasValidVmResources(vm: ScenarioVmManifestV3): boolean {
  return (
    isPositiveU32(vm.cpu_millis) &&
    isPositiveU16(vm.vcpu_count) &&
    vm.cpu_millis <= vm.vcpu_count * 1000 &&
    isPositiveU32(vm.memory_mib) &&
    isPositiveU32(vm.disk_mib)
  );
}

export function validateVmProbes(
  probes: ScenarioProbeManifestV3[],
): Response | null {
  if (!Array.isArray(probes)) {
    return jsonResponse({ error: "manifest contains an invalid probe" }, 400);
  }
  const probeIds = new Set<string>();
  for (const probe of probes) {
    const probeId = readString(probe.id);
    if (
      !probeId ||
      !isSafeRegistrySlug(probeId) ||
      probeIds.has(probeId) ||
      !isProbePhase(probe.phase) ||
      !readString(probe.kind) ||
      !readString(probe.display_name) ||
      !isOptionalString(probe.title) ||
      !isOptionalString(probe.body_markdown)
    ) {
      return jsonResponse({ error: "manifest contains an invalid probe" }, 400);
    }
    probeIds.add(probeId);
    if (!hasValidHintList(probe.hints)) {
      return jsonResponse(
        { error: "manifest contains invalid probe hints" },
        400,
      );
    }
  }
  return null;
}

export function hasValidHintList(hints: ScenarioHintManifestV3[]): boolean {
  if (!Array.isArray(hints)) {
    return false;
  }
  const ids = new Set<string>();
  for (const hint of hints) {
    const id = readString(hint.id);
    if (
      !id ||
      !isSafeRegistrySlug(id) ||
      ids.has(id) ||
      !isOptionalString(hint.title) ||
      !readString(hint.body_markdown)
    ) {
      return false;
    }
    ids.add(id);
  }
  return true;
}

export function imageFileForVm(
  form: FormData,
  vm: ScenarioVmManifestV3,
): File | null {
  const field = form.get(`image:${vm.name}`);
  if (field instanceof File) return field;

  const imageKey = `${registryImageKey(vm.image_key)}.raw.zst`;
  for (const entry of form.getAll("image")) {
    if (entry instanceof File && entry.name === imageKey) {
      return entry;
    }
  }

  return null;
}

export function artifactFileForSha(
  form: FormData,
  sha256: string,
): File | null {
  const field = form.get(`artifact:${sha256}`);
  if (field instanceof File) return field;

  for (const entry of form.getAll("artifact")) {
    if (entry instanceof File && artifactFilenameMatches(entry.name, sha256)) {
      return entry;
    }
  }

  return null;
}
