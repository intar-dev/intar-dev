import { readFile } from "node:fs/promises";
import type { ScenarioManifestV3 } from "../../src/generated/catalog";
import { HttpError, type RequiredImage } from "./types";

export function sameImageKey(
  left: RequiredImage["image_key"],
  right: RequiredImage["image_key"],
): boolean {
  return (
    left.scenario === right.scenario &&
    left.vm === right.vm &&
    left.arch === right.arch
  );
}

export function imageLabel(vm: RequiredImage): string {
  return `${vm.image_key.scenario}/${vm.image_key.vm}/${vm.image_key.arch}@${vm.image_sha256.slice(0, 12)}`;
}

export function bootArtifactSha256s(manifest: ScenarioManifestV3): string[] {
  const values = new Set<string>();
  for (const vm of manifest.vms) {
    values.add(vm.boot.kernel_sha256.toLowerCase());
    values.add(vm.boot.initrd_sha256.toLowerCase());
  }
  return [...values].sort();
}

export async function sha256FileHex(path: string): Promise<string> {
  const bytes = await readFile(path);
  return sha256BytesHex(bytes);
}

export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copyToArrayBuffer(bytes),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return parseResponseText(text);
}

export function parseResponseText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function parseJsonText<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorMessage(error)}`);
  }
}

export function assertRawPayloadDoesNotContain(
  payload: string,
  forbidden: string,
  label: string,
): void {
  const variants = unique([
    forbidden,
    JSON.stringify(forbidden).slice(1, -1),
  ]).filter((value) => value.length > 0);
  for (const variant of variants) {
    if (payload.includes(variant)) {
      throw new Error(`${label} leaked solution body before reveal`);
    }
  }
}

export function parseControlMessage(
  raw: string,
):
  | { type: "ready" }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    if (parsed.type === "ready") return { type: "ready" };
    if (parsed.type === "exit" && Number.isSafeInteger(parsed.code)) {
      return { type: "exit", code: parsed.code as number };
    }
    if (parsed.type === "error" && typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }
  } catch {
    return null;
  }
  return null;
}

export async function decodeWebSocketData(
  data: unknown,
  textDecoder: TextDecoder,
): Promise<string | null> {
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(data, { stream: true });
  }
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(data, { stream: true });
  }
  if (data instanceof Blob) {
    return textDecoder.decode(await data.arrayBuffer(), { stream: true });
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function hasBody(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function expectHttpErrorCode(
  action: () => Promise<unknown>,
  status: number,
  code: string,
  description: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === status &&
      errorBodyCode(error.body) === code
    ) {
      return;
    }
    throw new Error(
      `${description} returned unexpected error: ${errorMessage(error)}`,
    );
  }
  throw new Error(`${description} unexpectedly succeeded`);
}

export function errorBodyCode(body: unknown): string | null {
  return isRecord(body) && typeof body.code === "string" ? body.code : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function logStep(message: string): void {
  console.log(`[live-e2e] ${message}`);
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.message} (${error.status}): ${JSON.stringify(error.body)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
