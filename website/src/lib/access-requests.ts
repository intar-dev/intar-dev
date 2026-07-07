import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessRequests } from "@/db/schema";
import {
  addToAllowlist,
  isValidGithubUsername,
  removeFromAllowlist,
  toAllowlistKey,
} from "@/lib/allowlist";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

export interface AccessRequestRecord {
  id: string;
  githubUsername: string;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

const NOTE_MAX_LENGTH = 1000;

// Public submit. Idempotent per username: repeat submissions never leak
// whether the name is known, allowlisted, or already decided.
export async function submitAccessRequest(params: {
  username: string;
  note?: string | null;
}): Promise<void> {
  const username = toAllowlistKey(params.username);
  if (!username || !isValidGithubUsername(username)) {
    throw appError(400, "invalid_username", "a valid GitHub username is required");
  }

  const note = params.note?.trim().slice(0, NOTE_MAX_LENGTH) || null;
  const db = drizzle(env.DB);

  await db
    .insert(accessRequests)
    .values({
      id: createAppId(),
      githubUsername: username,
      note,
      status: "pending",
    })
    .onConflictDoNothing({ target: accessRequests.githubUsername });
}

export async function listAccessRequests(): Promise<AccessRequestRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(accessRequests)
    .orderBy(desc(accessRequests.createdAt))
    .limit(200);
  return rows;
}

export async function decideAccessRequest(params: {
  id: string;
  decision: "approved" | "rejected";
  adminUserId: string;
}): Promise<AccessRequestRecord> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(accessRequests)
    .where(eq(accessRequests.id, params.id))
    .limit(1);
  const request = rows[0];
  if (!request) {
    throw appError(404, "access_request_not_found", "access request not found");
  }

  const now = Date.now();
  if (params.decision === "approved") {
    await addToAllowlist(request.githubUsername, {
      approvedBy: params.adminUserId,
      approvedAt: now,
    });
  } else if (request.status === "approved") {
    // Rejecting a previously-approved request revokes the allowlist entry.
    await removeFromAllowlist(request.githubUsername);
  }

  await db
    .update(accessRequests)
    .set({
      status: params.decision,
      decidedBy: params.adminUserId,
      decidedAt: now,
    })
    .where(eq(accessRequests.id, params.id));

  return {
    ...request,
    status: params.decision,
    decidedBy: params.adminUserId,
    decidedAt: now,
  };
}
