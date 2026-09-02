import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test/host-runtime-worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-20",
        compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
        bindings: {
          AGENT_JWT_AUDIENCE: "agent-connect",
          AGENT_JWT_ISSUER: "intar-agent-bridge",
          AGENT_JWT_SECRET: "test-agent-jwt-secret-0123456789abcdef",
          BETTER_AUTH_APP_NAME: "intar.dev",
          BETTER_AUTH_SECRET:
            "test-better-auth-secret-that-is-at-least-32-bytes",
          BETTER_AUTH_URL: "http://localhost",
          ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1:
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
          OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1:
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          REGISTRY_PUBLISH_TOKEN: "test-publish-token",
          SCENARIO_RUN_KEY_ENCRYPTION_SECRET: "test-run-key-secret",
          SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON:
            '{"schema_version":1,"bootstrap_abi":1,"tools_disk_sha256":"1111111111111111111111111111111111111111111111111111111111111111","tools_disk_size_bytes":67108864,"compressed_disk_sha256":"3333333333333333333333333333333333333333333333333333333333333333","compressed_disk_size_bytes":1,"kino_sha256":"2222222222222222222222222222222222222222222222222222222222222222","kino_size_bytes":1}',
          STARGATE_ADMIN_AUTH_AUDIENCE: "stargate-admin",
          STARGATE_ADMIN_AUTH_HEADER: "cf-access-jwt-assertion",
          STARGATE_ADMIN_AUTH_ISSUER: "intar.dev",
          STARGATE_ADMIN_AUTH_SECRET: "test-stargate-secret",
          STARGATE_ROUTE_TTL_SECONDS: "14400",
          STARGATE_WORKSPACE_APP_BASE_DOMAIN: "intar.app",
          STARGATE_EGRESS_IPV4_CIDRS: "192.0.2.10/32",
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
    setupFiles: ["./src/test/worker-setup.ts"],
  },
});
