import { defineConfig } from "drizzle-kit";

const baseConfig = {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: process.env.DRIZZLE_MIGRATIONS_OUT?.trim() || "./migrations",
  breakpoints: true,
  migrations: {
    prefix: "index",
  },
} as const;

const remoteMode = process.env.DRIZZLE_D1_HTTP;
if (remoteMode !== undefined && remoteMode !== "0" && remoteMode !== "1") {
  throw new Error("DRIZZLE_D1_HTTP must be 0, 1, or unset");
}
const useD1Http = remoteMode === "1";

const config = useD1Http
  ? defineConfig({
      ...baseConfig,
      driver: "d1-http",
      dbCredentials: {
        accountId: requiredEnvironmentVariable("CLOUDFLARE_ACCOUNT_ID"),
        databaseId: requiredEnvironmentVariable("CLOUDFLARE_DATABASE_ID"),
        token:
          process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
          requiredEnvironmentVariable("CLOUDFLARE_API_TOKEN"),
      },
    })
  : defineConfig(baseConfig);

export default config;

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when DRIZZLE_D1_HTTP=1`);
  }
  return value;
}
