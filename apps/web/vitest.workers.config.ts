import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
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
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          // The Kino artifact revision-runs.workers.test.ts stores; without
          // it in the registry the pin reads as unset.
          KINO_PINS_JSON:
            '{"3":{"current":"sha256:ba84da6c273cceb718a63a6374ceeebc4ad862fd4098e570ed71937fe01b4639","previous":null}}',
          GITHUB_APP_WEBHOOK_SECRET: "test-github-webhook-secret",
          REGISTRY_PUBLISH_TOKEN: "test-publish-token",
          SCENARIO_RUN_KEY_ENCRYPTION_SECRET: "test-run-key-secret",
          STARGATE_ADMIN_AUTH_AUDIENCE: "stargate-admin",
          STARGATE_ADMIN_AUTH_HEADER: "cf-access-jwt-assertion",
          STARGATE_ADMIN_AUTH_ISSUER: "intar.dev",
          STARGATE_ADMIN_AUTH_SECRET: "test-stargate-secret",
          STARGATE_ROUTE_TTL_SECONDS: "14400",
        },
        serviceBindings: {
          STARGATE_ADMIN_SERVICE: async (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/v1/host-relays/grant") {
              const grant = await request.json() as { identity: unknown; expires_at_unix_ms: number };
              return Response.json({
                websocket_url: "wss://relay.example.test/host", token: "a".repeat(64),
                gateway_host_key_openssh: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC8RhyqlniULcwGMBBuwmhTSMOZUalITtxBKhuxfuDd4",
                identity: grant.identity, expires_at_unix_ms: grant.expires_at_unix_ms,
              });
            }
            if (path.startsWith("/v1/host-relays/revoke")) return new Response(null, {status: 204});
            if (path.startsWith("/v1/run-mirrors/")) return new Response(null, {status: 204});
            return new Response("test service has no such route", {status: 404});
          },
        },
        d1Databases: ["DB"],
        durableObjects: {
          HOST_RUNTIME: {
            className: "HostRuntimeDO",
            useSQLite: true,
          },
          SCENARIO_SOURCE: {
            className: "ScenarioSourceDO",
            useSQLite: true,
          },
          RUN_SHARE: {
            className: "RunShareDO",
            useSQLite: true,
          },
        },
        r2Buckets: ["SHARE_LIVE_BUCKET", "VM_IMAGE_REGISTRY_BUCKET", "VM_RUN_ARTIFACTS_BUCKET"],
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
    // With the file system module cache, the pool inlines every cached module
    // of a warm-module reply into one WebSocket message. For the auth module
    // graph that message grows past workerd's 32 MiB limit, the runner socket
    // closes with 1009 and the test file never starts.
    fsModuleCache: false,
  },
});
