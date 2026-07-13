import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const remote = process.argv.includes("--remote");
const from = readArgument("--from");
const migrations = (await readdir(new URL("../drizzle", import.meta.url)))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right))
  .filter((name) => !from || name >= from);

if (migrations.length === 0) {
  throw new Error(from ? `no D1 migrations found at or after ${from}` : "no D1 migrations found");
}

for (const migration of migrations) {
  console.log(`Applying ${migration} to ${remote ? "remote" : "local"} D1`);
  const command = [
    "node",
    "node_modules/@cloudflare/vite-plugin/node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "DB",
    remote ? "--remote" : "--local",
    "--file",
    `drizzle/${migration}`,
    "--config",
    remote ? "wrangler.jsonc" : "wrangler.local.jsonc",
  ];
  if (!remote) {
    command.push("--persist-to", ".wrangler/local-ui-state");
  }
  const [executable, ...args] = command;
  if (!executable) {
    throw new Error("D1 migration command is empty");
  }
  const child = spawn(executable, args, {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`D1 migration ${migration} failed with exit code ${exitCode}`);
  }
}

function readArgument(name: string): string | null {
  const equals = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals) {
    return equals.slice(name.length + 1).trim() || null;
  }
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1]?.trim() || null;
}
