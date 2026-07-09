import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";

const migrationSources = import.meta.glob<string>("../../drizzle/*.sql", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const d1Migrations = Object.entries(migrationSources)
  .map(([path, raw]) => ({
    name: path.split("/").at(-1) ?? path,
    queries: splitMigration(raw),
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

export async function resetD1Database(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, d1Migrations);
}

function splitMigration(raw: string): string[] {
  return raw
    .split("--> statement-breakpoint")
    .map((query) => query.trim())
    .filter(Boolean);
}
