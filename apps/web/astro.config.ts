import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

import react from "@astrojs/react";

import tailwindcss from "@tailwindcss/vite";

const isLocalDevelopment =
  process.argv.includes("dev") || process.argv.includes("preview");

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  adapter: cloudflare({
    imageService: "compile",
    configPath: isLocalDevelopment
      ? "./wrangler.local.jsonc"
      : "./wrangler.jsonc",
    auxiliaryWorkers: [
      {
        // The image registry cleanup worker builds and deploys with this site.
        // It keeps its own bindings, its own cron, and its own type file.
        configPath: isLocalDevelopment
          ? "./workers/image-registry-cleanup/wrangler.local.jsonc"
          : "./workers/image-registry-cleanup/wrangler.jsonc",
      },
    ],
    persistState: isLocalDevelopment
      ? process.env.PLAYWRIGHT_UI === "1"
        ? false
        : { path: ".wrangler/local-ui-state" }
      : true,
    remoteBindings: false,
  }),

  output: "server",

  session: false,

  vite: {
    define: {
      "import.meta.env.PUBLIC_RELEASE_VERSION": JSON.stringify(process.env.GITHUB_SHA ?? "development"),
    },
    optimizeDeps: {
      // The telemetry page script is outside Astro's client scan entries,
      // which skip .astro files. Found on the first page load instead, it
      // re-bundles every client dependency and in-flight chunk requests 404.
      include: ["@grafana/faro-web-sdk", "@grafana/faro-web-tracing"],
    },
    server: {
      watch: {
        ignored: [
          "**/tests/ui/__screenshots__/**",
          "**/playwright-report/**",
          "**/test-results/**",
        ],
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                // Not "terminal": lucide's Terminal icon gets that chunk name.
                name: "xterm",
                test: /node_modules[\\/]@xterm[\\/]/,
                priority: 30,
              },
            ],
          },
        },
      },
    },
    ssr: {
      optimizeDeps: {
        // Pre-bundle what the first server render needs. A dependency found
        // on that request re-optimizes the bundle and reloads every open page,
        // which fails the first UI test of each worker.
        include: [
          "picomatch",
          "@better-auth/core/context",
          "@better-auth/oauth-provider",
          "@better-auth/sso",
          "astro/app/manifest",
          "better-auth",
          "better-auth/adapters/drizzle",
          "better-auth/api",
          "better-auth/plugins",
        ],
      },
      external: [
        "node:async_hooks",
        "node:util",
        "node:stream",
        "node:events",
        "node:os",
        "node:path",
        "node:crypto",
        "node:child_process",
        "node:fs",
        "child_process",
        "fs",
      ],
    },

    plugins: [tailwindcss() as any],
  },

  integrations: [react()],
});
