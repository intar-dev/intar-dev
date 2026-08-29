import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildNativeSshArgs,
  intarCliRemoteArgs,
  issueNativeSshRoute,
  remoteShellCommand,
  runNativeSsh,
  withNativeSshMaterial,
  type IssuedNativeSshRoute,
  type NativeSshConnection,
} from "../../scripts/live-e2e/native-ssh";

const connection: NativeSshConnection = {
  authMode: "issued_key",
  host: "ssh.intar.test",
  port: 2222,
  username: "run-web-native",
  knownHostsLine: "[ssh.intar.test]:2222 ssh-ed25519 AAAATEST",
};

describe("live E2E native SSH helper", () => {
  it("uses an issued route with strict host verification and no local SSH config", () => {
    const args = buildNativeSshArgs({
      connection,
      material: {
        privateKeyPath: "/tmp/issued.key",
        knownHostsPath: "/tmp/known_hosts",
      },
      remoteArgs: intarCliRemoteArgs(["check"]),
      tty: false,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "-T",
        "-F",
        "/dev/null",
        "-i",
        "/tmp/issued.key",
        "StrictHostKeyChecking=yes",
        "UserKnownHostsFile=/tmp/known_hosts",
        "GlobalKnownHostsFile=/dev/null",
        "IdentitiesOnly=yes",
        "BatchMode=yes",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "-p",
        "2222",
        "run-web-native@ssh.intar.test",
        "'env' 'TERM=dumb' 'LANG=C' 'NO_COLOR=1' 'CI=1' 'intar' 'check'",
      ]),
    );
  });

  it("allows the bare intar summary command", () => {
    expect(intarCliRemoteArgs([])).toEqual([
      "env",
      "TERM=dumb",
      "LANG=C",
      "NO_COLOR=1",
      "CI=1",
      "intar",
    ]);
  });

  it("uses a forced TTY only for the interactive Bash completion proof", () => {
    const args = buildNativeSshArgs({
      connection,
      material: {
        privateKeyPath: "/tmp/issued.key",
        knownHostsPath: "/tmp/known_hosts",
      },
      remoteArgs: ["bash", "-ic", "complete -p intar"],
      tty: true,
    });

    expect(args[0]).toBe("-tt");
    expect(args.at(-1)).toBe("'bash' '-ic' 'complete -p intar'");
  });

  it("quotes every remote argument as one literal shell argument", () => {
    expect(remoteShellCommand(["intar", "hint", "general; rm -rf /"])).toBe(
      "'intar' 'hint' 'general; rm -rf /'",
    );
    expect(remoteShellCommand(["echo", "a'b"])).toBe("'echo' 'a'\"'\"'b'");
  });

  it("writes temporary key material with restrictive modes and removes it", async () => {
    let directory = "";
    await withNativeSshMaterial(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----\n",
      "ssh.intar.test ssh-ed25519 AAAATEST",
      async (material) => {
        directory = dirname(material.privateKeyPath);
        const [privateKey, knownHosts, privateKeyStats, knownHostsStats] =
          await Promise.all([
            readFile(material.privateKeyPath, "utf8"),
            readFile(material.knownHostsPath, "utf8"),
            stat(material.privateKeyPath),
            stat(material.knownHostsPath),
          ]);
        expect(privateKey).toContain("OPENSSH PRIVATE KEY");
        expect(knownHosts).toBe("ssh.intar.test ssh-ed25519 AAAATEST\n");
        expect(privateKeyStats.mode & 0o777).toBe(0o600);
        expect(knownHostsStats.mode & 0o777).toBe(0o600);
      },
    );

    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects control characters in the server-provided known_hosts line", () => {
    expect(() =>
      buildNativeSshArgs({
        connection: { ...connection, knownHostsLine: "host ssh-ed25519 key\nextra" },
        material: {
          privateKeyPath: "/tmp/issued.key",
          knownHostsPath: "/tmp/known_hosts",
        },
        remoteArgs: ["intar", "status"],
        tty: false,
      }),
    ).toThrow("invalid known_hosts");
  });

  it("issues a one-run public key rather than relying on a profile key", async () => {
    const json = vi.fn().mockResolvedValue({
      routeUsername: "run-web-native",
      expiresAt: 1_000,
      native: connection,
    });

    const issued = await issueNativeSshRoute({
      client: { json } as never,
      runId: "run-1",
      vmId: "vm-1",
    });

    expect(json).toHaveBeenCalledWith(
      "/api/scenarios/runs/run-1/ssh",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          vmId: "vm-1",
          mode: "native",
          clientPublicKeyOpenssh: expect.stringMatching(/^ssh-ed25519 /),
        }),
      }),
    );
    expect(issued.route.native.authMode).toBe("issued_key");
    expect(issued.privateKeyOpenssh).toContain("OPENSSH PRIVATE KEY");
  });

  it("preserves the learner CLI exit and stream contract over native SSH", async () => {
    await expect(runFakeNativeSsh("usage")).resolves.toMatchObject({
      exitCode: 2,
      stdout: "",
      stderr: expect.stringContaining("Usage:"),
    });
    await expect(runFakeNativeSsh("unavailable")).resolves.toMatchObject({
      exitCode: 4,
      stdout: "",
      stderr: expect.stringContaining("unavailable"),
    });
    await expect(runFakeNativeSsh("interrupted")).resolves.toMatchObject({
      exitCode: 130,
      stdout: "",
      stderr: expect.stringContaining("Interrupted"),
    });
  });

  it("keeps TERM=dumb plain output free from ANSI controls", async () => {
    const execution = await runFakeNativeSsh("plain");

    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toContain("[FAIL]");
    expect(execution.stdout + execution.stderr).not.toMatch(
      /\u001b|[\u0080-\u009f]/,
    );
  });

  it("preserves a remote broken-pipe semantic exit rather than rewriting it", async () => {
    // Kino chooses the semantic command exit code before it handles a local
    // recording/output pipe error. The SSH harness must forward that code.
    await expect(runFakeNativeSsh("broken-pipe")).resolves.toMatchObject({
      exitCode: 1,
      stdout: "failed checks\n",
      stderr: "",
    });
  });
});

const issued: IssuedNativeSshRoute = {
  route: {
    routeUsername: "run-web-native",
    expiresAt: 1_000,
    native: connection,
  },
  privateKeyOpenssh:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----\n",
};

async function runFakeNativeSsh(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "intar-live-e2e-fake-ssh-"));
  const sshPath = join(directory, "ssh");
  const originalPath = process.env.PATH;
  const originalMode = process.env.INTAR_LIVE_E2E_FAKE_SSH_MODE;
  await writeFile(
    sshPath,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *TERM=dumb*LANG=C*NO_COLOR=1*CI=1*) ;;",
      "  *) exit 98 ;;",
      "esac",
      'case "${INTAR_LIVE_E2E_FAKE_SSH_MODE:-}" in',
      "  usage) printf 'Usage: intar ...\\n' >&2; exit 2 ;;",
      "  unavailable) printf 'Intar is unavailable. Try again.\\n' >&2; exit 4 ;;",
      "  interrupted) printf 'Interrupted.\\n' >&2; exit 130 ;;",
      "  broken-pipe) printf 'failed checks\\n'; exit 1 ;;",
      "  plain) printf 'INTAR - Broken Nginx\\n[FAIL] Needs repair\\n'; exit 0 ;;",
      "  *) exit 99 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(sshPath, 0o700);
  try {
    process.env.PATH = `${directory}${originalPath ? `:${originalPath}` : ""}`;
    process.env.INTAR_LIVE_E2E_FAKE_SSH_MODE = mode;
    return await runNativeSsh({
      issued,
      remoteArgs: intarCliRemoteArgs(["status"]),
      timeoutMs: 1_000,
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalMode === undefined) {
      delete process.env.INTAR_LIVE_E2E_FAKE_SSH_MODE;
    } else {
      process.env.INTAR_LIVE_E2E_FAKE_SSH_MODE = originalMode;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
