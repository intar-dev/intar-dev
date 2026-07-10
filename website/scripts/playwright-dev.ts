import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

// Astro records the background dev PID in the workspace. A container can stop
// abruptly and leave that PID file behind; the same PID may belong to an
// unrelated process in the next container. Clear only the ephemeral dev state
// before starting the foreground server supervised by Playwright.
await Promise.all([
  rm(".astro/dev.json", { force: true }),
  rm(".astro/dev.log", { force: true }),
]);

const child = spawn(
  "bun",
  [
    "run",
    "dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    "4330",
    "--force",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ASTRO_DEV_BACKGROUND: "0",
      PLAYWRIGHT_UI: "1",
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

const exitCode = await new Promise<number>((resolve) => {
  child.once("exit", (code) => resolve(code ?? 1));
});
process.exit(exitCode);
