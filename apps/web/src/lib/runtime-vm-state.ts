import { env } from "cloudflare:workers";
import type { VmActualStateV2 } from "@/generated/bridge";
import { appError, errorChainMatches } from "@/lib/app-error";
import { generateSshEd25519KeyPair } from "@/lib/ssh-ed25519";
import {
  recordRuntimeVmTerminalTarget,
  requireCurrentRuntimeGeneration,
} from "@/lib/runtime-executions";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface RuntimeVmAccessKey {
  executionId: string;
  runtimeVmId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
  privateKeyOpenssh: string;
}

export async function ensureRuntimeVmAccessKeys(input: {
  executionId: string;
  expectedGeneration: number;
  now?: number;
}): Promise<RuntimeVmAccessKey[]> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const now = timestamp(input.now ?? Date.now(), "now");
  const vms = await env.DB.prepare(
    `SELECT id, vm_id, runtime_vm_name
     FROM runtime_vms
     WHERE execution_id = ?
     ORDER BY ordinal ASC`,
  )
    .bind(execution.id)
    .all<{
      id: string;
      vm_id: string;
      runtime_vm_name: string;
    }>();
  if (!vms.results.length) {
    throw appError(409, "runtime_vm_missing", "runtime execution has no VMs");
  }

  for (const vm of vms.results) {
    const existing = await env.DB.prepare(
      `SELECT runtime_vm_id
       FROM runtime_vm_access_keys
       WHERE runtime_vm_id = ? AND execution_id = ?`,
    )
      .bind(vm.id, execution.id)
      .first<{ runtime_vm_id: string }>();
    if (existing) continue;

    const keyPair = generateSshEd25519KeyPair(
      `intar:${execution.id}:${vm.runtime_vm_name}`,
    );
    const encrypted = await encryptAccessKey({
      executionId: execution.id,
      runtimeVmId: vm.id,
      vmId: vm.vm_id,
      runtimeVmName: vm.runtime_vm_name,
      publicKeyOpenssh: keyPair.publicKeyOpenssh,
      privateKeyOpenssh: keyPair.privateKeyOpenssh,
    });
    try {
      await env.DB.prepare(
        `INSERT INTO runtime_vm_access_keys (
           runtime_vm_id, execution_id, public_key_openssh,
           private_key_ciphertext_b64, private_key_iv_b64, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM runtime_executions current
           WHERE current.id = ?
             AND current.generation = ?
             AND NOT EXISTS (
               SELECT 1 FROM runtime_executions newer
               WHERE newer.domain_kind = current.domain_kind
                 AND newer.domain_id = current.domain_id
                 AND newer.generation > current.generation
             )
         )`,
      )
        .bind(
          vm.id,
          execution.id,
          keyPair.publicKeyOpenssh,
          encrypted.ciphertextB64,
          encrypted.ivB64,
          now,
          execution.id,
          input.expectedGeneration,
        )
        .run();
    } catch (error) {
      if (
        !errorChainMatches(error, /runtime_vm_access_keys|UNIQUE constraint/)
      ) {
        throw error;
      }
    }
  }

  await requireCurrentRuntimeGeneration(execution.id, input.expectedGeneration);
  return Promise.all(
    vms.results.map((vm) =>
      loadRuntimeVmAccessKey({
        executionId: execution.id,
        expectedGeneration: input.expectedGeneration,
        vmId: vm.vm_id,
      }),
    ),
  );
}

export async function loadRuntimeVmAccessKey(input: {
  executionId: string;
  expectedGeneration: number;
  vmId: string;
}): Promise<RuntimeVmAccessKey> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const vmId = required(input.vmId, "vmId");
  const row = await env.DB.prepare(
    `SELECT
       vm.id AS runtime_vm_id,
       vm.vm_id,
       vm.runtime_vm_name,
       access.public_key_openssh,
       access.private_key_ciphertext_b64,
       access.private_key_iv_b64
     FROM runtime_vms vm
     INNER JOIN runtime_vm_access_keys access
       ON access.runtime_vm_id = vm.id
      AND access.execution_id = vm.execution_id
     WHERE vm.execution_id = ? AND vm.vm_id = ?`,
  )
    .bind(execution.id, vmId)
    .first<{
      runtime_vm_id: string;
      vm_id: string;
      runtime_vm_name: string;
      public_key_openssh: string;
      private_key_ciphertext_b64: string;
      private_key_iv_b64: string;
    }>();
  if (!row) {
    throw appError(
      409,
      "runtime_vm_access_key_missing",
      "runtime VM access credentials are not ready",
    );
  }
  return {
    executionId: execution.id,
    runtimeVmId: row.runtime_vm_id,
    vmId: row.vm_id,
    runtimeVmName: row.runtime_vm_name,
    publicKeyOpenssh: row.public_key_openssh,
    privateKeyOpenssh: await decryptAccessKey({
      executionId: execution.id,
      runtimeVmId: row.runtime_vm_id,
      vmId: row.vm_id,
      runtimeVmName: row.runtime_vm_name,
      publicKeyOpenssh: row.public_key_openssh,
      ciphertextB64: row.private_key_ciphertext_b64,
      ivB64: row.private_key_iv_b64,
    }),
  };
}

export async function recordRuntimeVmActualState(input: {
  executionId: string;
  expectedGeneration: number;
  vmId: string;
  hostId: string;
  report: VmActualStateV2;
  observedAt?: number;
  expectedHostSessionId?: string;
}): Promise<"updated" | "stale"> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const vmId = required(input.vmId, "vmId");
  const hostId = required(input.hostId, "hostId");
  const expectedHostSessionId = optional(input.expectedHostSessionId);
  if (
    execution.host_id !== hostId ||
    execution.state === "archived" ||
    execution.state === "failed"
  ) {
    return "stale";
  }
  const vm = await env.DB.prepare(
    `SELECT id, runtime_vm_name
     FROM runtime_vms
     WHERE execution_id = ? AND vm_id = ?`,
  )
    .bind(execution.id, vmId)
    .first<{ id: string; runtime_vm_name: string }>();
  if (!vm) {
    throw appError(404, "runtime_vm_not_found", "runtime VM not found");
  }
  if (
    input.report.run_id !== execution.id ||
    input.report.vm_name !== vm.runtime_vm_name
  ) {
    return "stale";
  }
  const observedAt = timestamp(
    input.observedAt ?? input.report.updated_at_unix_ms,
    "observedAt",
  );
  const result = await env.DB.prepare(
    `INSERT INTO runtime_vm_actual_state (
       runtime_vm_id, execution_id, host_id, phase, desired_version,
       report_json, observed_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1
       FROM runtime_executions current
       INNER JOIN agent_hosts host ON host.id = current.host_id
       WHERE current.id = ?
         AND current.generation = ?
         AND current.host_id = ?
         AND current.state NOT IN ('archived', 'failed')
         AND (? IS NULL OR host.active_session_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM runtime_executions newer
           WHERE newer.domain_kind = current.domain_kind
             AND newer.domain_id = current.domain_id
             AND newer.generation > current.generation
         )
     )
     ON CONFLICT (runtime_vm_id) DO UPDATE SET
       execution_id = excluded.execution_id,
       host_id = excluded.host_id,
       phase = excluded.phase,
       desired_version = excluded.desired_version,
       report_json = excluded.report_json,
       observed_at = excluded.observed_at,
       updated_at = excluded.updated_at
     WHERE excluded.execution_id = runtime_vm_actual_state.execution_id
       AND excluded.host_id = runtime_vm_actual_state.host_id
       AND excluded.observed_at >= runtime_vm_actual_state.observed_at
       AND EXISTS (
         SELECT 1 FROM agent_hosts host
         WHERE host.id = excluded.host_id
           AND (? IS NULL OR host.active_session_id = ?)
       )`,
  )
    .bind(
      vm.id,
      execution.id,
      hostId,
      input.report.phase,
      input.report.desired_version ?? null,
      JSON.stringify(input.report),
      observedAt,
      observedAt,
      execution.id,
      input.expectedGeneration,
      hostId,
      expectedHostSessionId,
      expectedHostSessionId,
      expectedHostSessionId,
      expectedHostSessionId,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return "stale";

  const target = input.report.terminal.target;
  const hostKeyOpenssh = input.report.ssh_host_keys_openssh[0];
  if (input.report.terminal.state === "ready" && target && hostKeyOpenssh) {
    const key = await loadRuntimeVmAccessKey({
      executionId: execution.id,
      expectedGeneration: input.expectedGeneration,
      vmId,
    });
    await recordRuntimeVmTerminalTarget({
      executionId: execution.id,
      expectedGeneration: input.expectedGeneration,
      vmId,
      target: {
        host: target.host,
        port: target.port,
        username: target.username,
        hostKeyOpenssh,
        privateKeyOpenssh: key.privateKeyOpenssh,
      },
      observedAt,
    });
  }
  return "updated";
}

async function encryptAccessKey(input: RuntimeVmAccessKey): Promise<{
  ciphertextB64: string;
  ivB64: string;
}> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: copyBuffer(iv),
      additionalData: copyBuffer(accessKeyContext(input)),
    },
    await encryptionKey(),
    copyBuffer(textEncoder.encode(input.privateKeyOpenssh)),
  );
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
    ivB64: bytesToBase64(iv),
  };
}

async function decryptAccessKey(input: {
  executionId: string;
  runtimeVmId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
  ciphertextB64: string;
  ivB64: string;
}): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: copyBuffer(base64ToBytes(input.ivB64)),
      additionalData: copyBuffer(accessKeyContext(input)),
    },
    await encryptionKey(),
    copyBuffer(base64ToBytes(input.ciphertextB64)),
  );
  return textDecoder.decode(plaintext);
}

async function encryptionKey(): Promise<CryptoKey> {
  const secret = env.SCENARIO_RUN_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw appError(
      500,
      "runtime_key_secret_missing",
      "runtime credential encryption is not configured",
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

function accessKeyContext(input: {
  executionId: string;
  runtimeVmId: string;
  vmId: string;
  runtimeVmName: string;
  publicKeyOpenssh: string;
}): Uint8Array {
  return textEncoder.encode(
    `${input.executionId}\0${input.runtimeVmId}\0${input.vmId}\0${input.runtimeVmName}\0${input.publicKeyOpenssh}`,
  );
}

function required(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw appError(400, "runtime_execution_invalid", `${label} is required`);
  }
  return normalized;
}

function optional(value: string | undefined): string | null {
  return value === undefined ? null : required(value, "expectedHostSessionId");
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(
      400,
      "runtime_execution_invalid",
      `${label} must be a Unix millisecond timestamp`,
    );
  }
  return value;
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

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
