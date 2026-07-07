import { env } from "cloudflare:workers";
import { toAllowlistKey } from "@/lib/github-username";

// The sign-up allowlist is a KV namespace keyed by normalized GitHub
// username. auth.ts consults it on user/session create; the admin
// access-request flow writes to it. Worker-only — pure username helpers
// live in lib/github-username.ts so the client bundle can use them.

export { isValidGithubUsername, toAllowlistKey } from "@/lib/github-username";

function allowlistKv(): KVNamespace | null {
  return (env as { ALLOWLIST?: KVNamespace }).ALLOWLIST ?? null;
}

export async function isAllowlisted(username?: string | null): Promise<boolean> {
  const key = toAllowlistKey(username);
  if (!key) return false;

  const allowlist = allowlistKv();
  if (!allowlist) return false;
  const entry = await allowlist.get(key);
  return entry !== null;
}

export async function addToAllowlist(
  username: string,
  metadata: { approvedBy: string; approvedAt: number },
): Promise<void> {
  const key = toAllowlistKey(username);
  if (!key) {
    throw new Error("allowlist key is required");
  }
  const allowlist = allowlistKv();
  if (!allowlist) {
    throw new Error("ALLOWLIST KV binding is not configured");
  }
  await allowlist.put(key, JSON.stringify(metadata));
}

export async function removeFromAllowlist(username: string): Promise<void> {
  const key = toAllowlistKey(username);
  if (!key) {
    throw new Error("allowlist key is required");
  }
  const allowlist = allowlistKv();
  if (!allowlist) {
    throw new Error("ALLOWLIST KV binding is not configured");
  }
  await allowlist.delete(key);
}
