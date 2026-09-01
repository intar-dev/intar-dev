import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshEd25519KeyPair } from "../../src/lib/ssh-ed25519";
import type { ApiClient } from "./api-client";

const MAX_SSH_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SSH_TIMEOUT_MS = 30_000;

export interface NativeSshRoute {
  routeUsername: string;
  expiresAt: number;
  native: NativeSshConnection;
}

export interface NativeSshConnection {
  authMode: "issued_key" | "profile_keys";
  host: string;
  port: number;
  username: string;
  knownHostsLine: string;
}

export interface IssuedNativeSshRoute {
  route: NativeSshRoute;
  privateKeyOpenssh: string;
}

export interface NativeSshExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface NativeSshRouteResponse {
  routeUsername?: unknown;
  expiresAt?: unknown;
  native?: {
    authMode?: unknown;
    host?: unknown;
    port?: unknown;
    username?: unknown;
    knownHostsLine?: unknown;
  };
}

export interface NativeSshMaterial {
  privateKeyPath: string;
  knownHostsPath: string;
}

/**
 * Issue a disposable workshop native route with a fresh client key. The
 * private half stays in this process for the duration of each SSH command.
 */
export async function issueNativeSshRouteRequest(input: {
  client: ApiClient;
  path: string;
  body: Record<string, unknown>;
  keyComment: string;
}): Promise<IssuedNativeSshRoute> {
  const keyPair = generateSshEd25519KeyPair(input.keyComment);
  const response = await input.client.json<NativeSshRouteResponse>(input.path, {
    method: "POST",
    json: {
      ...input.body,
      mode: "native",
      clientPublicKeyOpenssh: keyPair.publicKeyOpenssh,
    },
  });

  return {
    route: parseIssuedNativeSshRoute(response),
    privateKeyOpenssh: keyPair.privateKeyOpenssh,
  };
}

/**
 * Run a command through the issued route without ever consulting the local
 * SSH configuration or a global known-hosts file. `remoteArgs` are shell
 * quoted into one remote command so learner-controlled text cannot alter the
 * local ssh invocation.
 */
export async function runNativeSsh(input: {
  issued: IssuedNativeSshRoute;
  remoteArgs: string[];
  tty?: boolean;
  timeoutMs?: number;
}): Promise<NativeSshExecution> {
  if (!input.remoteArgs.length) {
    throw new Error("native SSH requires a remote command");
  }

  return withNativeSshMaterial(
    input.issued.privateKeyOpenssh,
    input.issued.route.native.knownHostsLine,
    async (material) =>
      runSshProcess(
        buildNativeSshArgs({
          connection: input.issued.route.native,
          material,
          remoteArgs: input.remoteArgs,
          tty: input.tty ?? false,
        }),
        input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
      ),
  );
}

/**
 * The learner CLI must render plain text for machine-launched live checks.
 * Setting the full plain profile here also makes a stray interactive read
 * impossible to hide behind terminal behaviour.
 */
export function intarCliRemoteArgs(command: string[]): string[] {
  return [
    "env",
    "TERM=dumb",
    "LANG=C",
    "NO_COLOR=1",
    "CI=1",
    "intar",
    ...command,
  ];
}

export function buildNativeSshArgs(input: {
  connection: NativeSshConnection;
  material: NativeSshMaterial;
  remoteArgs: string[];
  tty: boolean;
}): string[] {
  const connection = validateNativeSshConnection(input.connection);
  if (!input.remoteArgs.length) {
    throw new Error("native SSH requires a remote command");
  }

  return [
    input.tty ? "-tt" : "-T",
    "-F",
    "/dev/null",
    "-i",
    input.material.privateKeyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "NumberOfPasswordPrompts=0",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${input.material.knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=10",
    "-p",
    String(connection.port),
    `${connection.username}@${connection.host}`,
    remoteShellCommand(input.remoteArgs),
  ];
}

export function remoteShellCommand(args: string[]): string {
  if (!args.length) throw new Error("remote shell command is required");
  return args.map(shellQuote).join(" ");
}

export async function withNativeSshMaterial<T>(
  privateKeyOpenssh: string,
  knownHostsLine: string,
  operation: (material: NativeSshMaterial) => Promise<T>,
): Promise<T> {
  const safeKnownHostsLine = validateKnownHostsLine(knownHostsLine);
  if (!privateKeyOpenssh.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    throw new Error("issued native SSH route did not provide an OpenSSH key");
  }

  const directory = await mkdtemp(join(tmpdir(), "intar-workshop-ssh-"));
  const privateKeyPath = join(directory, "issued.key");
  const knownHostsPath = join(directory, "known_hosts");
  try {
    await writeFile(privateKeyPath, privateKeyOpenssh, { mode: 0o600 });
    await writeFile(knownHostsPath, `${safeKnownHostsLine}\n`, {
      mode: 0o600,
    });
    // `writeFile` honours the current umask only for a new file. Enforce the
    // restrictive mode explicitly so a reused or unusual temporary directory
    // cannot weaken this proof.
    await Promise.all([
      chmod(privateKeyPath, 0o600),
      chmod(knownHostsPath, 0o600),
    ]);
    return await operation({ privateKeyPath, knownHostsPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseIssuedNativeSshRoute(
  value: NativeSshRouteResponse,
): NativeSshRoute {
  if (
    typeof value.routeUsername !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    !value.native
  ) {
    throw new Error("native SSH route response is incomplete");
  }

  return {
    routeUsername: value.routeUsername,
    expiresAt: value.expiresAt,
    native: validateNativeSshConnection({
      authMode: value.native.authMode,
      host: value.native.host,
      port: value.native.port,
      username: value.native.username,
      knownHostsLine: value.native.knownHostsLine,
    }),
  };
}

function validateNativeSshConnection(value: {
  authMode: unknown;
  host: unknown;
  port: unknown;
  username: unknown;
  knownHostsLine: unknown;
}): NativeSshConnection {
  if (value.authMode !== "issued_key" && value.authMode !== "profile_keys") {
    throw new Error("native SSH route has an invalid authentication mode");
  }
  if (!isSafeSshAddressPart(value.host)) {
    throw new Error("native SSH route has an invalid host");
  }
  if (!isSafeSshAddressPart(value.username)) {
    throw new Error("native SSH route has an invalid username");
  }
  if (
    typeof value.port !== "number" ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new Error("native SSH route has an invalid port");
  }

  return {
    authMode: value.authMode,
    host: value.host,
    port: value.port,
    username: value.username,
    knownHostsLine: validateKnownHostsLine(value.knownHostsLine),
  };
}

function validateKnownHostsLine(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("native SSH route has an invalid known_hosts entry");
  }
  return value.trim();
}

function isSafeSshAddressPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\s\u0000-\u001f\u007f@]/.test(value)
  );
}

async function runSshProcess(
  args: string[],
  timeoutMs: number,
): Promise<NativeSshExecution> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("native SSH timeout must be a positive integer");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (overflowed) return;
      const current = target === "stdout" ? stdout : stderr;
      if (
        Buffer.byteLength(current) + chunk.byteLength >
        MAX_SSH_OUTPUT_BYTES
      ) {
        overflowed = true;
        child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") {
        stdout += Buffer.from(chunk).toString("utf8");
      } else {
        stderr += Buffer.from(chunk).toString("utf8");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`native SSH could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (overflowed) {
        reject(
          new Error("native SSH output exceeded the workshop proof safety limit"),
        );
        return;
      }
      if (timedOut) {
        reject(new Error("native SSH command timed out"));
        return;
      }
      if (signal !== null || code === null) {
        reject(new Error("native SSH command ended without an exit code"));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
