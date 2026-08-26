import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.intar.dev",
  integrations: [
    starlight({
      title: "Intar Documentation",
      description:
        "Architecture, authoring contracts, and operations runbooks for the Intar platform.",
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
      sidebar: [
        { slug: "index" },
        {
          label: "Architecture",
          autogenerate: { directory: "architecture" },
        },
        {
          label: "Authoring",
          autogenerate: { directory: "authoring" },
        },
        {
          label: "Operations",
          autogenerate: { directory: "operations" },
        },
        {
          label: "Decisions",
          autogenerate: { directory: "adr" },
        },
      ],
    }),
  ],
});
