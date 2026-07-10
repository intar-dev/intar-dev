import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

import react from "@astrojs/react";

import tailwindcss from "@tailwindcss/vite";

const isLocalDevelopment = process.argv.includes("dev");

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  adapter: cloudflare({
    imageService: "compile",
    configPath: isLocalDevelopment
      ? "./wrangler.local.jsonc"
      : "./wrangler.jsonc",
    persistState: isLocalDevelopment
      ? process.env.PLAYWRIGHT_UI === "1"
        ? false
        : { path: ".wrangler/local-ui-state" }
      : true,
    remoteBindings: false,
  }),

  output: "server",

  vite: {
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
                name: "terminal",
                test: /node_modules[\\/]@xterm[\\/]/,
                priority: 30,
              },
              {
                name: "editor",
                test: /node_modules[\\/]@codemirror[\\/]/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
    resolve: {
      dedupe: ["@codemirror/state", "@codemirror/view"],
    },
    ssr: {
      optimizeDeps: {
        include: ["picomatch"],
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
