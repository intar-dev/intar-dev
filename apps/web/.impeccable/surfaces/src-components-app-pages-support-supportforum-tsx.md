---
version: 1
slug: "src-components-app-pages-support-supportforum-tsx"
primary_target: "src/components/app/pages/support/SupportForum.tsx"
related_targets: ["src/components/app/pages/support/SupportTopic.tsx","src/components/app/pages/support/SupportNewTopic.tsx"]
---

# Support forum

Mode: Operate and Read. Active Intar users share bugs, help requests, and feedback across organizations. Authors and platform administrators can resolve topics. Users own their text; administrators can remove posts.

## Direction contract

THESIS: A clear topic list leads to a readable discussion and an explicit resolution action.

OWN-WORLD: Use Intar's existing light and dark themes, warm action color, type styles, quiet borders, and app bar.

STORY: Find a related report, add useful details, then check whether it is solved.

FIRST VIEWPORT: New topic sits in the app bar. Search and filters precede compact topic rows. The detail page starts with the full title, status, and author, then the description and comments in a narrow column. The app bar names the page Topic so long titles stay readable in the content.

FORM: Topic list and flat discussion; user-approved implementation plan specifies this local extension. No visual identity change or concept selection is needed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
