import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioRunSshKeys } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { generateSshEd25519KeyPair } from "@/lib/ssh-ed25519";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ScenarioRunSshKeyDraft {
  id: string;
  runId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
  privateKeyOpenssh: string;
}

export interface ScenarioRunSshKeyRecord {
  id: string;
  runId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
  privateKeyOpenssh: string;
}

export function generateScenarioRunSshKeyDraft(input: {
  runId: string;
  vmId: string;
  runtimeVmName: string;
}): ScenarioRunSshKeyDraft {
  const keyPair = generateSshEd25519KeyPair(
    `intar:${input.runId}:${input.runtimeVmName}`,
  );
  return {
    id: createAppId(),
    runId: input.runId,
    vmId: input.vmId,
    runtimeVmName: input.runtimeVmName,
    publicKeyOpenssh: keyPair.publicKeyOpenssh,
    privateKeyOpenssh: keyPair.privateKeyOpenssh,
  };
}

export async function insertScenarioRunSshKeyDrafts(
  drafts: ScenarioRunSshKeyDraft[],
  createdAt: number,
): Promise<void> {
  if (drafts.length === 0) {
    return;
  }

  const rows = await Promise.all(
    drafts.map(async (draft) => {
      const encrypted = await encryptPrivateKey(draft);
      return {
        id: draft.id,
        runId: draft.runId,
        vmId: draft.vmId,
        runtimeVmName: draft.runtimeVmName,
        publicKeyOpenssh: draft.publicKeyOpenssh,
        privateKeyCiphertextB64: encrypted.ciphertextB64,
        privateKeyIvB64: encrypted.ivB64,
        createdAt,
      };
    }),
  );

  await drizzle(env.DB).insert(scenarioRunSshKeys).values(rows);
}

export async function loadScenarioRunSshKey(input: {
  runId: string;
  vmId: string;
}): Promise<ScenarioRunSshKeyRecord> {
  const row = await drizzle(env.DB)
    .select()
    .from(scenarioRunSshKeys)
    .where(
      and(
        eq(scenarioRunSshKeys.runId, input.runId),
        eq(scenarioRunSshKeys.vmId, input.vmId),
      ),
    )
    .limit(1);
  const key = row[0];
  if (!key) {
    throw appError(
      409,
      "scenario_ssh_key_missing",
      "terminal credentials are not ready for this VM",
    );
  }

  return {
    id: key.id,
    runId: key.runId,
    vmId: key.vmId,
    runtimeVmName: key.runtimeVmName,
    publicKeyOpenssh: key.publicKeyOpenssh,
    privateKeyOpenssh: await decryptPrivateKey({
      runId: key.runId,
      vmId: key.vmId,
      runtimeVmName: key.runtimeVmName,
      publicKeyOpenssh: key.publicKeyOpenssh,
      ciphertextB64: key.privateKeyCiphertextB64,
      ivB64: key.privateKeyIvB64,
    }),
  };
}

async function encryptPrivateKey(input: ScenarioRunSshKeyDraft): Promise<{
  ciphertextB64: string;
  ivB64: string;
}> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(encryptionContext(input)),
    },
    await encryptionKey(),
    toArrayBuffer(textEncoder.encode(input.privateKeyOpenssh)),
  );
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
    ivB64: bytesToBase64(iv),
  };
}

async function decryptPrivateKey(input: {
  runId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
  ciphertextB64: string;
  ivB64: string;
}): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64ToBytes(input.ivB64)),
      additionalData: toArrayBuffer(encryptionContext(input)),
    },
    await encryptionKey(),
    toArrayBuffer(base64ToBytes(input.ciphertextB64)),
  );
  return textDecoder.decode(plaintext);
}

async function encryptionKey(): Promise<CryptoKey> {
  const secret = env.SCENARIO_RUN_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw appError(
      500,
      "scenario_ssh_key_secret_missing",
      "scenario SSH key encryption is not configured",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function encryptionContext(input: {
  runId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
}): Uint8Array {
  return textEncoder.encode(
    `${input.runId}\0${input.vmId}\0${input.runtimeVmName}\0${input.publicKeyOpenssh}`,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(bytes.length);
  output.set(bytes);
  return output.buffer;
}
