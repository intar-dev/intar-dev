import { env } from "cloudflare:workers";
import { auth } from "@/lib/auth";

export interface AccessClaimIdentity {
  userId: string;
  name: string;
  githubAccountId: string | null;
  githubUsername: string | null;
  accessState: "active" | "blocked" | null;
}

interface ClaimIdentityRow {
  user_id: string;
  name: string;
  github_account_id: string | null;
  github_username: string | null;
  access_state: "active" | "blocked" | null;
}

export async function getAccessClaimIdentity(
  request: Request,
): Promise<AccessClaimIdentity | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return null;

  const row = await env.DB.prepare(
    `SELECT identity.id AS user_id,
            identity.name,
            github.account_id AS github_account_id,
            identity.username AS github_username,
            access.state AS access_state
     FROM user AS identity
     LEFT JOIN account AS github
       ON github.user_id = identity.id AND github.provider_id = 'github'
     LEFT JOIN access_allowlist AS access
       ON access.user_id = identity.id
     WHERE identity.id = ?1
     LIMIT 1`,
  )
    .bind(userId)
    .first<ClaimIdentityRow>();
  if (!row) return null;

  return {
    userId: row.user_id,
    name: row.name,
    githubAccountId: row.github_account_id,
    githubUsername: row.github_username,
    accessState: row.access_state,
  };
}
