import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("pinned Stargate SSH configuration", () => {
  it("writes a strict config without exposing the private key", async () => {
    const fixture = await sshFixture();
    const outputDirectory = join(fixture.root, "configured");
    const result = spawnSync(
      "bash",
      ["tools/deploy/configure-stargate-ssh.sh", outputDirectory],
      { cwd: process.cwd(), env: fixture.environment, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${outputDirectory}/config\n`);
    const config = await readFile(join(outputDirectory, "config"), "utf8");
    expect(config).toContain("HostName intar.app");
    expect(config).toContain("User stargate-deploy");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("ClearAllForwardings yes");
    expect(config).not.toContain(fixture.privateKey);
    expect((await stat(join(outputDirectory, "config"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(outputDirectory, "id_ed25519"))).mode & 0o777).toBe(0o600);
  });

  it("rejects an unpinned endpoint or extra known-host entries", async () => {
    const fixture = await sshFixture();
    const wrongHost = spawnSync(
      "bash",
      ["tools/deploy/configure-stargate-ssh.sh", join(fixture.root, "wrong-host")],
      {
        cwd: process.cwd(),
        env: { ...fixture.environment, STARGATE_DEPLOY_HOST: "example.com" },
        encoding: "utf8",
      },
    );
    expect(wrongHost.status).not.toBe(0);

    const extraHost = spawnSync(
      "bash",
      ["tools/deploy/configure-stargate-ssh.sh", join(fixture.root, "extra-host")],
      {
        cwd: process.cwd(),
        env: {
          ...fixture.environment,
          STARGATE_DEPLOY_KNOWN_HOSTS: `${fixture.knownHosts}\n${fixture.knownHosts}`,
        },
        encoding: "utf8",
      },
    );
    expect(extraHost.status).not.toBe(0);
  });
});

async function sshFixture(): Promise<{
  root: string;
  privateKey: string;
  knownHosts: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "intar-stargate-ssh-test-"));
  temporaryDirectories.push(root);
  const keyPath = join(root, "fixture-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const privateKey = await readFile(keyPath, "utf8");
  const [type, key] = (await readFile(`${keyPath}.pub`, "utf8")).trim().split(/\s+/);
  const knownHosts = `[intar.app]:2222 ${type} ${key}`;
  return {
    root,
    privateKey,
    knownHosts,
    environment: {
      ...process.env,
      STARGATE_DEPLOY_HOST: "intar.app",
      STARGATE_DEPLOY_PORT: "2222",
      STARGATE_DEPLOY_USER: "stargate-deploy",
      STARGATE_DEPLOY_SSH_PRIVATE_KEY: privateKey,
      STARGATE_DEPLOY_KNOWN_HOSTS: knownHosts,
    },
  };
}
