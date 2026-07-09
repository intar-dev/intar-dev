import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

import react from "@astrojs/react";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare({
    imageService: "compile",
    remoteBindings: false,
  }),

  output: "server",

  vite: {
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
