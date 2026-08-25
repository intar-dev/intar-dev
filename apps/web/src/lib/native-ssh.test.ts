import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildTemporaryNativeSshCommand,
  temporaryNativeSshKeyFilename,
} from "./native-ssh";

describe("temporary native SSH", () => {
  it("derives a safe download filename from the route", () => {
    expect(temporaryNativeSshKeyFilename("Run_01/Web SSH")).toBe(
      "intar-run-01-web-ssh.key",
    );
    expect(temporaryNativeSshKeyFilename("  ")).toBe(
      "intar-temporary-route.key",
    );
  });

  it("builds a strict command around the downloaded key", () => {
    const command = buildTemporaryNativeSshCommand({
      username: "run-web-ssh-issued",
      host: "intar.app",
      port: 22,
      knownHostsLine: "intar.app ssh-ed25519 AAAATEST",
      keyFilename: "intar-run-web-ssh-issued.key",
    });

    expect(command).toBe(
      [
        "(",
        '  key_path="$HOME/Downloads/intar-run-web-ssh-issued.key"',
        '  known_hosts_file="$(mktemp)"',
        `  trap 'rm -f "$known_hosts_file"' EXIT`,
        '  chmod 600 "$key_path"',
        `  printf '%s\\n' 'intar.app ssh-ed25519 AAAATEST' > "$known_hosts_file"`,
        `  ssh -i "$key_path" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts_file" 'run-web-ssh-issued@intar.app'`,
        ")",
      ].join("\n"),
    );
    expect(() =>
      execFileSync("bash", ["-n"], { input: command }),
    ).not.toThrow();
  });

  it("adds a non-standard public port", () => {
    expect(
      buildTemporaryNativeSshCommand({
        username: "route",
        host: "ssh.example.test",
        port: 2222,
        knownHostsLine: "[ssh.example.test]:2222 ssh-ed25519 AAAATEST",
        keyFilename: "intar-route.key",
      }),
    ).toContain(" -p 2222 'route@ssh.example.test'");
  });
});
