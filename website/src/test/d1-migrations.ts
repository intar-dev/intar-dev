import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import migration0000 from "../../drizzle/0000_oval_sasquatch.sql?raw";
import migration0001 from "../../drizzle/0001_watery_kronos.sql?raw";
import migration0002 from "../../drizzle/0002_wooden_archangel.sql?raw";
import migration0003 from "../../drizzle/0003_soft_jack_power.sql?raw";
import migration0004 from "../../drizzle/0004_access-requests.sql?raw";
import migration0005 from "../../drizzle/0005_teams.sql?raw";
import migration0006 from "../../drizzle/0006_scenario-sources.sql?raw";
import migration0007 from "../../drizzle/0007_scenario-category.sql?raw";
import migration0008 from "../../drizzle/0008_probe-kind.sql?raw";

const migrations = [
  { name: "0000_oval_sasquatch.sql", queries: splitMigration(migration0000) },
  { name: "0001_watery_kronos.sql", queries: splitMigration(migration0001) },
  { name: "0002_wooden_archangel.sql", queries: splitMigration(migration0002) },
  { name: "0003_soft_jack_power.sql", queries: splitMigration(migration0003) },
  { name: "0004_access-requests.sql", queries: splitMigration(migration0004) },
  { name: "0005_teams.sql", queries: splitMigration(migration0005) },
  { name: "0006_scenario-sources.sql", queries: splitMigration(migration0006) },
  {
    name: "0007_scenario-category.sql",
    queries: splitMigration(migration0007),
  },
  { name: "0008_probe-kind.sql", queries: splitMigration(migration0008) },
];

export async function resetD1Database(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, migrations);
}

function splitMigration(raw: string): string[] {
  return raw
    .split("--> statement-breakpoint")
    .map((query) => query.trim())
    .filter(Boolean);
}
