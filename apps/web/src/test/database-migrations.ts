import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";

const migrationSources = import.meta.glob<string>(
  "../../migrations/*.sql",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
);

export const databaseMigrations = Object.entries(migrationSources)
  .map(([path, raw]) => ({
    name: path.split("/").at(-1) ?? path,
    queries: raw
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean),
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

export async function resetDatabase(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, databaseMigrations);
}
