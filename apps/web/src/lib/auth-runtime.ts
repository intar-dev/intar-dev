import { env } from "cloudflare:workers";

type AuthSettingName =
  | "BETTER_AUTH_URL"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_APP_NAME"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET";

// Local tooling can set these in process.env; the Worker reads its bindings.
const runtimeEnv =
  "process" in globalThis
    ? (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env
    : undefined;

/** A Better Auth setting, from process.env first, then the Worker bindings. */
export function authSetting(name: AuthSettingName): string | undefined {
  return (
    runtimeEnv?.[name] ??
    (env as unknown as Partial<Record<AuthSettingName, string>>)[name]
  );
}
