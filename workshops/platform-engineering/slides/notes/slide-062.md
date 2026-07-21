The build-vs-buy interlude — be honest in both directions, because "bespoke always" is as wrong as "Backstage by default".

Bespoke won HERE because the platform is small and the audience is the builder: everything fits on one screen, the source is readable over coffee, and there's no team to staff. Those conditions are real in small orgs and internal tools — and they're exactly the conditions that vanish at scale.

Backstage earns its weight when you need: the plugin ecosystem (ArgoCD, PagerDuty, Sonar, cost insights — integrations you'd otherwise write AND maintain), a catalog with real ownership metadata across dozens of teams and hundreds of services, and TechDocs/scaffolder golden paths with an ecosystem behind them.

The costs are real too: roughly 2 GB of Node.js plus a Postgres, YAML-heavy configuration, and — the big one — typically a team that owns it. The closing line, verbatim from the lab: a portal is a PRODUCT decision, not a default.

Next slide: trace the Backstage integration loop and compare every hop with the live Cloudbox path, so this isn't a straw man. V1 deliberately exposes no Backstage app route.
