import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.intar.dev",
  integrations: [
    starlight({
      title: "Intar Documentation",
      description: "Documentation for the Intar platform is coming soon.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/intar-dev/intar-dev",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/intar-dev/intar-dev/edit/main/docs/",
      },
    }),
  ],
});
