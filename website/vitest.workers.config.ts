import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test/host-runtime-worker.ts",
      miniflare: {
        compatibilityDate: "2026-07-09",
        compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
        bindings: {
          AGENT_JWT_AUDIENCE: "agent-connect",
          AGENT_JWT_ISSUER: "intar-agent-bridge",
          AGENT_JWT_SECRET: "test-agent-jwt-secret-0123456789abcdef",
          BETTER_AUTH_APP_NAME: "intar.dev",
          BETTER_AUTH_SECRET: "test-better-auth-secret",
          BETTER_AUTH_URL: "http://localhost",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          REGISTRY_PUBLISH_TOKEN: "test-publish-token",
          SCENARIO_RUN_KEY_ENCRYPTION_SECRET: "test-run-key-secret",
          STARGATE_ADMIN_AUTH_AUDIENCE: "stargate-admin",
          STARGATE_ADMIN_AUTH_HEADER: "cf-access-jwt-assertion",
          STARGATE_ADMIN_AUTH_ISSUER: "intar.dev",
          STARGATE_ADMIN_AUTH_SECRET: "test-stargate-secret",
          STARGATE_ROUTE_TTL_SECONDS: "14400",
        },
        d1Databases: ["DB"],
        durableObjects: {
          HOST_RUNTIME: {
            className: "HostRuntimeDO",
            useSQLite: true,
          },
        },
        r2Buckets: ["VM_IMAGE_REGISTRY_BUCKET", "VM_RUN_ARTIFACTS_BUCKET"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.workers.test.ts"],
  },
});
