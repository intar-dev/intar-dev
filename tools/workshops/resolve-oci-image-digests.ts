#!/usr/bin/env bun

/**
 * Resolve a workshop image inventory to immutable registry manifest digests.
 *
 * This talks directly to OCI Distribution endpoints. It never invokes a
 * container engine and it deliberately fails the whole run if one tag cannot
 * be resolved. The output is review material; the checked-in lock remains the
 * publication input so normal workshop imports stay deterministic/offline.
 */

import { readFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  throw new Error("usage: bun tools/workshops/resolve-oci-image-digests.ts IMAGES.txt");
}

const accept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface ImageReference {
  original: string;
  registry: string;
  repository: string;
  reference: string;
}

const images = readFileSync(source, "utf8")
  .split(/\r?\n/u)
  .map((line) => line.replace(/\s+#.*$/u, "").trim())
  .filter((line) => line && !line.startsWith("#") && !/^\[[^\]]+\]$/u.test(line));

const results: string[] = [];
const failures: string[] = [];
for (const value of images) {
  try {
    const parsed = parseImage(value);
    if (parsed.reference.startsWith("sha256:")) {
      const observed = await resolveDigest(parsed);
      if (observed !== parsed.reference) {
        throw new Error(
          `${value}: registry resolved ${observed}, expected ${parsed.reference}`,
        );
      }
      results.push(value);
      continue;
    }
    const digest = await resolveDigest(parsed);
    results.push(`${value}\t${parsed.registry}/${parsed.repository}@${digest}`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
process.stdout.write(`${results.join("\n")}\n`);
if (failures.length) {
  throw new Error(
    `failed to resolve ${failures.length} image reference(s):\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
}

function parseImage(value: string): ImageReference {
  if (/\s/u.test(value)) throw new Error(`image reference contains whitespace: ${value}`);
  const slash = value.indexOf("/");
  if (slash <= 0) throw new Error(`image reference must include a registry: ${value}`);
  const registry = value.slice(0, slash).toLowerCase();
  const rest = value.slice(slash + 1);
  const digestAt = rest.lastIndexOf("@sha256:");
  if (digestAt >= 0) {
    const digest = rest.slice(digestAt + 1);
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
      throw new Error(`invalid digest: ${value}`);
    }
    return { original: value, registry, repository: rest.slice(0, digestAt), reference: digest };
  }
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon <= lastSlash || colon === rest.length - 1) {
    throw new Error(`tag is required before digest resolution: ${value}`);
  }
  return {
    original: value,
    registry,
    repository: rest.slice(0, colon),
    reference: rest.slice(colon + 1),
  };
}

async function resolveDigest(image: ImageReference): Promise<string> {
  const registryHost = image.registry === "docker.io"
    ? "registry-1.docker.io"
    : image.registry;
  const url = `https://${registryHost}/v2/${image.repository}/manifests/${encodeURIComponent(image.reference)}`;
  let response = await fetch(url, {
    method: "HEAD",
    headers: { Accept: accept },
    redirect: "follow",
  });
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate");
    if (!challenge) throw new Error(`${image.original}: registry omitted auth challenge`);
    const authorization = await bearerAuthorization(challenge, image);
    response = await fetch(url, {
      method: "HEAD",
      headers: { Accept: accept, Authorization: authorization },
      redirect: "follow",
    });
  }
  if (!response.ok) {
    throw new Error(`${image.original}: registry returned HTTP ${response.status}`);
  }
  const digest = response.headers.get("docker-content-digest")?.toLowerCase();
  if (!digest || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${image.original}: registry returned no valid Docker-Content-Digest`);
  }
  return digest;
}

async function bearerAuthorization(
  challenge: string,
  image: ImageReference,
): Promise<string> {
  const match = challenge.match(/^Bearer\s+(.+)$/iu);
  if (!match) throw new Error(`${image.original}: unsupported auth challenge`);
  const parameters = new Map<string, string>();
  for (const item of match[1]!.matchAll(/([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/gu)) {
    parameters.set(item[1]!.toLowerCase(), item[2]!);
  }
  const realm = parameters.get("realm");
  if (!realm?.startsWith("https://")) {
    throw new Error(`${image.original}: bearer realm must use HTTPS`);
  }
  const tokenUrl = new URL(realm);
  const service = parameters.get("service");
  if (service) tokenUrl.searchParams.set("service", service);
  tokenUrl.searchParams.set(
    "scope",
    parameters.get("scope") ?? `repository:${image.repository}:pull`,
  );
  const response = await fetch(tokenUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${image.original}: token service returned HTTP ${response.status}`);
  }
  const body = await response.json() as { token?: unknown; access_token?: unknown };
  const token = typeof body.token === "string"
    ? body.token
    : typeof body.access_token === "string"
    ? body.access_token
    : undefined;
  if (!token || token.length > 16_384 || /[\r\n\0]/u.test(token)) {
    throw new Error(`${image.original}: token service returned an invalid token`);
  }
  return `Bearer ${token}`;
}
