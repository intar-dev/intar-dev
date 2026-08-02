import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist } from "@/db/schema";
import { toAllowlistKey } from "@/lib/github-username";

// The sign-up allowlist lives in D1 so approval and revocation are strongly
// consistent with sessions and OAuth grants. Worker-only — pure username
// helpers live in lib/github-username.ts so the client bundle can use them.

export { isValidGithubUsername, toAllowlistKey } from "@/lib/github-username";

export async function isAllowlisted(username?: string | null): Promise<boolean> {
  const key = toAllowlistKey(username);
  if (!key) return false;

  const rows = await drizzle(env.DB)
    .select({ githubUsername: accessAllowlist.githubUsername })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.githubUsername, key))
    .limit(1);
  return rows.length === 1;
}
