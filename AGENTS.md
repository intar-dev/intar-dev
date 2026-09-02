# Repository instructions

## Database migrations

- Always create or update database migration SQL and metadata with `bun run --cwd apps/web db:generate` (Drizzle Kit).
- Never manually edit files in `apps/web/migrations/` or `apps/web/migrations/meta/`, except for the Cloudflare D1 foreign-key problem tracked in Drizzle issue `#4089`.
- For that exception, add or replace only the D1-compatible `PRAGMA defer_foreign_keys=ON/OFF` wrapper needed around generated schema statements. Do not manually change table, column, index, or data statements.
- For all other problems, change the typed schema or deployment mechanism and regenerate the migration.
