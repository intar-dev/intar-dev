import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

const BOOTSTRAP_TTL_MS = 30 * 60_000;
const DEFAULT_REPORT_TTL_MS = 25 * 60 * 60_000;
const TOKEN_BYTES = 32;

export interface WorkspaceAgentIdentity {
  executionId: string;
  workspaceId: string;
  generation: number;
}

export interface IssueWorkspaceAgentBootstrapInput {
  executionId: string;
  generation: number;
  checkpointArtifactId?: string;
  now?: number;
  baseUrl?: string;
  reportExpiresAt?: number;
  /** Fences bootstrap rotation to the active Hetzner provisioning attempt. */
  provisioningAttemptId?: string;
}

export interface IssuedWorkspaceAgentBootstrap {
  capability: string;
  expiresAt: number;
  identity: WorkspaceAgentIdentity;
  /** HTTPS base endpoint ending in `/`; the guest appends contract routes. */
  endpoint: string;
}

interface BootstrapSourceRow {
  execution_id: string;
  workspace_id: string;
  generation: number;
  lease_expires_at: number | null;
  checkpoint_artifact_id: string;
  checkpoint_r2_key: string;
  checkpoint_size_bytes: number;
}

/**
 * Issues (or, before it is consumed, rotates) the sole guest bootstrap
 * capability for a runtime generation. D1 receives only its SHA-256 digest.
 */
export async function issueWorkspaceAgentBootstrap(
  input: IssueWorkspaceAgentBootstrapInput,
): Promise<IssuedWorkspaceAgentBootstrap> {
  const now = input.now ?? Date.now();
  assertPositiveSafeInteger(input.generation, "generation");
  const provisioningAttemptId = input.provisioningAttemptId?.trim();
  if (input.provisioningAttemptId !== undefined && !provisioningAttemptId) {
    throw appError(
      400,
      "workspace_agent_provisioning_attempt_invalid",
      "the provisioning attempt is invalid",
    );
  }
  if (
    provisioningAttemptId &&
    !(await isActiveProvisioningAttempt(
      input.executionId,
      provisioningAttemptId,
    ))
  ) {
    throw provisioningSuperseded();
  }
  const publicBaseUrl = normalizePublicBaseUrl(
    input.baseUrl ?? env.BETTER_AUTH_URL,
  );
  const source = await env.DB.prepare(
    `SELECT
       execution.id AS execution_id,
       execution.domain_id AS workspace_id,
       execution.generation,
       execution.lease_expires_at,
       artifact.id AS checkpoint_artifact_id,
       artifact.r2_key AS checkpoint_r2_key,
       artifact.size_bytes AS checkpoint_size_bytes
     FROM runtime_executions execution
     INNER JOIN workshop_workspaces workspace
       ON workspace.id = execution.domain_id
     INNER JOIN workshop_workspace_generations workspace_generation
       ON workspace_generation.id = workspace.current_generation_id
      AND workspace_generation.workspace_id = workspace.id
      AND workspace_generation.runtime_execution_id = execution.id
      AND workspace_generation.ordinal = execution.generation
     INNER JOIN workshop_sessions session
       ON session.id = workspace.session_id
      AND session.organization_id = execution.organization_id
     INNER JOIN runtime_provider_checkpoint_artifacts artifact
       ON artifact.template_revision_id = session.template_revision_id
      AND artifact.checkpoint_id = execution.checkpoint_id
      AND artifact.provider_kind = 'hetzner_cloud'
      AND artifact.status = 'verified'
     WHERE execution.id = ?
       AND execution.domain_kind = 'workshop'
       AND execution.provider_kind = 'hetzner_cloud'
       AND execution.generation = ?
       AND (? IS NULL OR artifact.id = ?)
     LIMIT 1`,
  )
    .bind(
      input.executionId,
      input.generation,
      input.checkpointArtifactId ?? null,
      input.checkpointArtifactId ?? null,
    )
    .first<BootstrapSourceRow>();
  if (!source) {
    throw appError(
      409,
      "workspace_agent_generation_not_bootstrappable",
      "the runtime generation has no verified provider checkpoint",
    );
  }

  const checkpointObject = await env.VM_IMAGE_REGISTRY_BUCKET.head(
    source.checkpoint_r2_key,
  );
  if (
    !checkpointObject ||
    checkpointObject.size !== source.checkpoint_size_bytes
  ) {
    throw appError(
      409,
      "workspace_agent_checkpoint_unavailable",
      "the runtime checkpoint payload is unavailable",
    );
  }

  const reportExpiresAt = Math.min(
    input.reportExpiresAt ??
      source.lease_expires_at ??
      now + DEFAULT_REPORT_TTL_MS,
    source.lease_expires_at ?? Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(reportExpiresAt) || reportExpiresAt <= now) {
    throw appError(
      409,
      "workspace_agent_generation_expired",
      "the runtime generation lease has expired",
    );
  }

  const capability = randomCapability("iwa_boot");
  const capabilityHash = await sha256Hex(capability);
  const expiresAt = Math.min(now + BOOTSTRAP_TTL_MS, reportExpiresAt);
  const id = `wagc_${createAppId()}`;
  const result = await env.DB.prepare(
    `INSERT INTO runtime_provider_guest_credentials (
       id, execution_id, workspace_id, generation, control_plane_base_url,
       bootstrap_token_hash, bootstrap_expires_at, report_credential_expires_at,
       checkpoint_artifact_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       generation = excluded.generation,
       control_plane_base_url = excluded.control_plane_base_url,
       bootstrap_token_hash = excluded.bootstrap_token_hash,
       bootstrap_expires_at = excluded.bootstrap_expires_at,
       report_credential_expires_at = excluded.report_credential_expires_at,
       checkpoint_artifact_id = excluded.checkpoint_artifact_id,
       updated_at = excluded.updated_at
     WHERE runtime_provider_guest_credentials.bootstrap_consumed_at IS NULL
       AND (
         ? IS NULL OR EXISTS (
           SELECT 1 FROM hetzner_allocations allocation
           WHERE allocation.execution_id = ?
             AND allocation.provisioning_attempt_id = ?
             AND allocation.state IN ('pending', 'creating')
         )
       )`,
  )
    .bind(
      id,
      source.execution_id,
      source.workspace_id,
      source.generation,
      publicBaseUrl,
      capabilityHash,
      expiresAt,
      reportExpiresAt,
      source.checkpoint_artifact_id,
      now,
      now,
      provisioningAttemptId ?? null,
      source.execution_id,
      provisioningAttemptId ?? null,
    )
    .run();
  if (result.meta.changes !== 1) {
    if (
      provisioningAttemptId &&
      !(await isActiveProvisioningAttempt(
        source.execution_id,
        provisioningAttemptId,
      ))
    ) {
      throw provisioningSuperseded();
    }
    throw appError(
      409,
      "workspace_agent_bootstrap_already_consumed",
      "the runtime generation has already consumed its bootstrap capability",
    );
  }
  if (
    provisioningAttemptId &&
    !(await isActiveProvisioningAttempt(
      source.execution_id,
      provisioningAttemptId,
    ))
  ) {
    throw provisioningSuperseded();
  }

  return {
    capability,
    expiresAt,
    identity: {
      executionId: source.execution_id,
      workspaceId: source.workspace_id,
      generation: source.generation,
    },
    endpoint: new URL(
      "/api/runtime/workspace-agent/",
      publicBaseUrl,
    ).toString(),
  };
}

async function isActiveProvisioningAttempt(
  executionId: string,
  provisioningAttemptId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM hetzner_allocations
     WHERE execution_id = ? AND provisioning_attempt_id = ?
       AND state IN ('pending', 'creating')`,
  )
    .bind(executionId, provisioningAttemptId)
    .first<{ id: string }>();
  return row !== null;
}

function provisioningSuperseded() {
  return appError(
    409,
    "workspace_agent_provisioning_superseded",
    "a newer learner-server provisioning attempt has taken ownership",
  );
}

export interface BuildWorkspaceAgentCloudInitInput {
  identity: WorkspaceAgentIdentity;
  endpoint: string;
  bootstrapCapability: string;
  sshPublicKey: string;
  agentBinaryUrl: string;
  agentBinarySha256: string;
  kinoBinaryUrl: string;
  kinoBinarySha256: string;
  kinoProbes: Array<{ moduleId: string; probeId: string }>;
  checkpointApplyProgram?: string;
  checkpointSigningKeysJson?: string;
  kinoUrl?: string;
  maxCheckpointBytes?: number;
  maxArtifactBytes?: number;
}

export async function revokeWorkspaceAgentGeneration(input: {
  executionId: string;
  generation: number;
  now?: number;
}): Promise<void> {
  assertPositiveSafeInteger(input.generation, "generation");
  const now = input.now ?? Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE runtime_provider_guest_credentials
       SET bootstrap_expires_at = MIN(bootstrap_expires_at, ?),
           report_credential_revoked_at = COALESCE(report_credential_revoked_at, ?),
           checkpoint_download_expires_at = CASE
             WHEN checkpoint_download_expires_at IS NULL THEN NULL
             ELSE MIN(checkpoint_download_expires_at, ?)
           END,
           updated_at = ?
       WHERE execution_id = ? AND generation = ?`,
    ).bind(now, now, now, now, input.executionId, input.generation),
    env.DB.prepare(
      `UPDATE runtime_provider_artifact_upload_grants
       SET expires_at = MIN(expires_at, ?)
       WHERE execution_id = ? AND generation = ? AND used_at IS NULL`,
    ).bind(now, input.executionId, input.generation),
  ]);
}

/** Builds the minimal guest bootstrap document. It never accepts a provider token. */
export function buildWorkspaceAgentCloudInit(
  input: BuildWorkspaceAgentCloudInitInput,
): string {
  validateIdentity(input.identity);
  const endpoint = validateHttpsUrl(input.endpoint, true);
  const agentBinaryUrl = validateHttpsUrl(input.agentBinaryUrl, false);
  const kinoBinaryUrl = validateHttpsUrl(input.kinoBinaryUrl, false);
  const kinoUrl = validateLoopbackHttpUrl(
    input.kinoUrl ?? "http://127.0.0.1:18081/probes",
  );
  const checkpointApplyProgram = input.checkpointApplyProgram
    ? validateAbsolutePath(input.checkpointApplyProgram)
    : undefined;
  const checkpointSigningKeys = parseCheckpointSigningKeys(
    input.checkpointSigningKeysJson ??
      env.WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON,
  );
  const maxCheckpointBytes = positiveIntegerOrDefault(
    input.maxCheckpointBytes,
    512 * 1024 * 1024,
  );
  const maxArtifactBytes = positiveIntegerOrDefault(
    input.maxArtifactBytes,
    128 * 1024 * 1024,
  );
  if (!/^(ssh-|ecdsa-)[^\r\n\0]{16,8192}$/.test(input.sshPublicKey)) {
    throw appError(
      400,
      "workspace_agent_invalid_ssh_key",
      "the workspace agent SSH public key is invalid",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.agentBinarySha256)) {
    throw appError(
      400,
      "workspace_agent_invalid_binary_digest",
      "the workspace agent binary digest is invalid",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.kinoBinarySha256)) {
    throw appError(
      400,
      "workspace_agent_invalid_binary_digest",
      "the Kino binary digest is invalid",
    );
  }
  const kinoConfig = renderDirectGuestKinoConfig(input.kinoProbes);
  if (
    !input.bootstrapCapability ||
    input.bootstrapCapability.length > 4096 ||
    /[\r\n\0]/.test(input.bootstrapCapability)
  ) {
    throw appError(
      400,
      "workspace_agent_invalid_bootstrap_capability",
      "the workspace agent bootstrap capability is invalid",
    );
  }

  const bootstrapB64 = bytesToBase64(
    new TextEncoder().encode(input.bootstrapCapability),
  );
  const toml = (value: string) => JSON.stringify(value);
  const yaml = (value: string) => JSON.stringify(value);
  const signingKeysToml = `{ ${Object.entries(checkpointSigningKeys)
    .map(([keyId, publicKey]) => `${toml(keyId)} = ${toml(publicKey)}`)
    .join(", ")} }`;
  return `#cloud-config
# Generated by Intar. This document never contains a Hetzner credential.
packages:
  - ca-certificates
  - curl
  - openssh-server
  - procps
  - util-linux

users:
  - name: intar
    gecos: Intar Stargate
    shell: /bin/bash
    lock_passwd: true
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${yaml(input.sshPublicKey)}

write_files:
  - path: /etc/intar/workspace-agent.toml
    owner: root:root
    permissions: "0600"
    content: |
      identity = { execution_id = ${toml(input.identity.executionId)}, workspace_id = ${toml(input.identity.workspaceId)}, generation = ${input.identity.generation} }
      control_plane_endpoint = ${toml(endpoint)}
      bootstrap_capability_path = "/run/intar-workspace-agent/bootstrap"
      state_path = "/var/lib/intar-workspace-agent/state.json"
      checkpoint_tmpfs_dir = "/run/intar-workspace-agent/checkpoints"
${checkpointApplyProgram ? `      checkpoint_apply_program = ${toml(checkpointApplyProgram)}\n` : ""}      checkpoint_signing_keys = ${signingKeysToml}
      reconstruction_user = "intar"
      reconstruction_home = "/home/intar"
      kino_url = ${toml(kinoUrl)}
      max_checkpoint_bytes = ${maxCheckpointBytes}
      max_artifact_bytes = ${maxArtifactBytes}
      recording_dir = "/var/lib/kino-recordings"
      recording_upload_staging_dir = "/var/lib/intar-workspace-agent/recording-upload-staging"
      recording_drain_program = "/usr/libexec/intar-workspace-recording-drain"
      require_checkpoint_tmpfs = true

  - path: /run/intar-workspace-agent/bootstrap
    owner: root:root
    permissions: "0600"
    encoding: b64
    content: ${bootstrapB64}

  - path: /run/intar-workspace-agent/agent.sha256
    owner: root:root
    permissions: "0600"
    content: ${yaml(`${input.agentBinarySha256}  /usr/local/sbin/intar-workspace-agent.new\n`)}

  - path: /run/intar-workspace-agent/kino.sha256
    owner: root:root
    permissions: "0600"
    content: ${yaml(`${input.kinoBinarySha256}  /usr/local/sbin/kino.new\n`)}

  - path: /etc/kino/kino.hcl
    owner: root:root
    permissions: "0644"
    content: |
${indentCloudInit(kinoConfig, 6)}

  - path: /etc/kino/recording.hcl
    owner: root:root
    permissions: "0644"
    content: |
      server {
        bind = "tcp://127.0.0.1:0"
      }

      recording {
        output_dir = "/var/lib/kino-recordings"
        real_shell = "/bin/bash"
      }

  - path: /etc/ssh/sshd_config.d/90-intar-workshop.conf
    owner: root:root
    permissions: "0644"
    content: |
      PermitRootLogin no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PubkeyAuthentication yes
      AllowUsers intar
      AllowTcpForwarding yes
      GatewayPorts no
      X11Forwarding no
      PermitTunnel no
      AllowAgentForwarding no

  - path: /usr/libexec/intar-workshop-run-probe
    owner: root:root
    permissions: "0755"
    content: |
      #!/bin/sh
      set -u
      verifier="\${1:?missing verifier}"
      set +e
      /usr/bin/setpriv \\
        --reuid=intar \\
        --regid=intar \\
        --init-groups \\
        -- \\
        /usr/bin/env -i \\
          HOME=/home/intar \\
          USER=intar \\
          LOGNAME=intar \\
          SHELL=/bin/bash \\
          PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
          LANG=C.UTF-8 \\
          LC_ALL=C.UTF-8 \\
          "\${verifier}" </dev/null >/dev/null 2>&1
      status="\$?"
      set -e
      if [ "\${status}" -eq 0 ]; then
        printf '{"passed":true}\\n'
      else
        printf '{"passed":false}\\n'
        exit "\${status}"
      fi

  - path: /usr/local/sbin/intar-kino-shell
    owner: root:root
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      config=/etc/kino/recording.hcl
      if [ "\${SSH_ORIGINAL_COMMAND+x}" = x ]; then
        exec /usr/local/sbin/kino record-ssh --config "\${config}" --shell-startup interactive --command "\${SSH_ORIGINAL_COMMAND}"
      fi
      if [ "\${1:-}" = -c ]; then
        exec /usr/local/sbin/kino record-ssh --config "\${config}" --shell-startup interactive --command "\${2:-}"
      fi
      exec /usr/local/sbin/kino record-ssh --config "\${config}" --shell-startup interactive

  - path: /usr/libexec/intar-workspace-recording-drain
    owner: root:root
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      systemctl stop ssh.service
      pkill -HUP -u intar -x kino 2>/dev/null || true
      remaining=300
      while pgrep -u intar -x kino >/dev/null 2>&1; do
        [ "\${remaining}" -gt 0 ] || exit 1
        sleep 0.1
        remaining="\$((remaining - 1))"
      done

  - path: /etc/systemd/system/kino.service
    owner: root:root
    permissions: "0644"
    content: |
      [Unit]
      Description=Intar Kino workshop probe service
      Wants=network-online.target
      After=network-online.target
      ConditionPathExists=/etc/kino/kino.hcl

      [Service]
      Type=simple
      User=root
      Group=root
      UMask=0077
      ExecStart=/usr/local/sbin/kino --config /etc/kino/kino.hcl
      Restart=on-failure
      RestartSec=2s
      NoNewPrivileges=true
      PrivateTmp=true
      ProtectControlGroups=true
      RestrictSUIDSGID=true
      LockPersonality=true

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/intar-workspace-agent.service
    owner: root:root
    permissions: "0644"
    content: |
      [Unit]
      Description=Intar Workshop learner workspace agent
      Wants=network-online.target ssh.service kino.service
      After=network-online.target ssh.service kino.service
      ConditionPathExists=/etc/intar/workspace-agent.toml
      StartLimitIntervalSec=300
      StartLimitBurst=10

      [Service]
      Type=simple
      User=root
      Group=root
      UMask=0077
      Environment=RUST_LOG=intar_workspace_agent=info
      ExecStart=/usr/local/sbin/intar-workspace-agent --config /etc/intar/workspace-agent.toml
      Restart=on-failure
      RestartSec=5s
      TimeoutStopSec=30s
      PrivateTmp=true
      ProtectHome=read-only
      ReadWritePaths=/home/intar
      ProtectControlGroups=true
      RestrictSUIDSGID=true
      LockPersonality=true

      [Install]
      WantedBy=multi-user.target

bootcmd:
  - [mkdir, -p, /run/intar-workspace-agent/checkpoints, /var/lib/intar-workspace-agent, /var/lib/kino-recordings, /etc/kino]
  - [chmod, "0700", /run/intar-workspace-agent, /run/intar-workspace-agent/checkpoints, /var/lib/intar-workspace-agent]

runcmd:
  - [curl, --fail, --silent, --show-error, --location, ${yaml(agentBinaryUrl)}, --output, /usr/local/sbin/intar-workspace-agent.new]
  - [curl, --fail, --silent, --show-error, --location, ${yaml(kinoBinaryUrl)}, --output, /usr/local/sbin/kino.new]
  - [sha256sum, --check, --status, /run/intar-workspace-agent/agent.sha256]
  - [sha256sum, --check, --status, /run/intar-workspace-agent/kino.sha256]
  - [install, --owner=root, --group=root, --mode=0755, /usr/local/sbin/intar-workspace-agent.new, /usr/local/sbin/intar-workspace-agent]
  - [install, --owner=root, --group=root, --mode=0755, /usr/local/sbin/kino.new, /usr/local/sbin/kino]
  - [rm, --force, /usr/local/sbin/intar-workspace-agent.new]
  - [rm, --force, /usr/local/sbin/kino.new]
  - [chown, intar:intar, /var/lib/kino-recordings]
  - [chmod, "0700", /var/lib/kino-recordings]
  - [sh, -c, "grep -qxF /usr/local/sbin/intar-kino-shell /etc/shells || printf '%s\\n' /usr/local/sbin/intar-kino-shell >> /etc/shells"]
  - [usermod, --shell, /usr/local/sbin/intar-kino-shell, intar]
  - [sshd, -t]
  - [systemctl, restart, ssh.service]
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, kino.service, intar-workspace-agent.service]
`;
}

function renderDirectGuestKinoConfig(
  probes: Array<{ moduleId: string; probeId: string }>,
): string {
  if (probes.length > 512) {
    throw appError(
      400,
      "workspace_agent_invalid_kino_probes",
      "too many Kino probes were requested",
    );
  }
  const seen = new Set<string>();
  const lines = [
    "server {",
    '  bind = "tcp://127.0.0.1:18081"',
    "}",
    "",
    "defaults {",
    "  every_seconds = 5",
    "  timeout_seconds = 120",
    "}",
  ];
  for (const probe of probes) {
    if (
      !validKinoIdentifier(probe.moduleId) ||
      !validKinoIdentifier(probe.probeId) ||
      seen.has(probe.probeId)
    ) {
      throw appError(
        400,
        "workspace_agent_invalid_kino_probes",
        "the Kino probe mapping is invalid",
      );
    }
    seen.add(probe.probeId);
    lines.push(
      "",
      `probe ${JSON.stringify(probe.probeId)} {`,
      '  kind = "command_json_path"',
      `  argv = ["/usr/libexec/intar-workshop-run-probe", ${JSON.stringify(`/var/lib/intar-workshop-probes/${probe.moduleId}.sh`)}]`,
      '  json_path = "$.passed"',
      "  expected = true",
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

function validKinoIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function indentCloudInit(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .trimEnd()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function parseCheckpointSigningKeys(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw appError(
      500,
      "workspace_agent_signing_keys_invalid",
      "runtime bundle signing key configuration is invalid",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length < 1 ||
    Object.keys(parsed).length > 16
  ) {
    throw appError(
      500,
      "workspace_agent_signing_keys_invalid",
      "runtime bundle signing key configuration is invalid",
    );
  }
  const result: Record<string, string> = {};
  for (const [keyId, publicKey] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(keyId) ||
      typeof publicKey !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)
    ) {
      throw appError(
        500,
        "workspace_agent_signing_keys_invalid",
        "runtime bundle signing key configuration is invalid",
      );
    }
    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(atob(publicKey), (character) =>
        character.charCodeAt(0),
      );
    } catch {
      throw appError(
        500,
        "workspace_agent_signing_keys_invalid",
        "runtime bundle signing key configuration is invalid",
      );
    }
    if (decoded.byteLength !== 32) {
      throw appError(
        500,
        "workspace_agent_signing_keys_invalid",
        "runtime bundle signing key configuration is invalid",
      );
    }
    result[keyId] = publicKey;
  }
  return result;
}

function normalizePublicBaseUrl(value: string): string {
  const url = validateHttpsUrl(value, false);
  const parsed = new URL(url);
  return `${parsed.origin}/`;
}

function validateHttpsUrl(
  value: string,
  requireTrailingSlash: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw appError(
      400,
      "workspace_agent_invalid_url",
      "workspace agent URL is invalid",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    (requireTrailingSlash && !url.pathname.endsWith("/"))
  ) {
    throw appError(
      400,
      "workspace_agent_invalid_url",
      "workspace agent URL is invalid",
    );
  }
  return url.toString();
}

function validateLoopbackHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw appError(
      400,
      "workspace_agent_invalid_kino_url",
      "Kino URL is invalid",
    );
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw appError(
      400,
      "workspace_agent_invalid_kino_url",
      "Kino URL is invalid",
    );
  }
  return url.toString();
}

function validateAbsolutePath(value: string): string {
  if (!value.startsWith("/") || /[\r\n\0]/.test(value)) {
    throw appError(
      400,
      "workspace_agent_invalid_path",
      "workspace agent path is invalid",
    );
  }
  return value;
}

function validateIdentity(identity: WorkspaceAgentIdentity): void {
  for (const [name, value] of [
    ["executionId", identity.executionId],
    ["workspaceId", identity.workspaceId],
  ] as const) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      throw appError(
        400,
        "workspace_agent_invalid_identity",
        `${name} is invalid`,
      );
    }
  }
  assertPositiveSafeInteger(identity.generation, "generation");
}

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  assertPositiveSafeInteger(resolved, "size limit");
  return resolved;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw appError(
      400,
      "workspace_agent_invalid_input",
      `${name} must be a positive integer`,
    );
  }
}

function randomCapability(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return `${prefix}_${bytesToBase64Url(bytes)}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
