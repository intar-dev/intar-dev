import { env } from "cloudflare:workers";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist, member, workshopRegistryTokens } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";

const TOKEN_PREFIX = "intar_ws_";
const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_TOKEN_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;

export interface WorkshopRegistryTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export async function createWorkshopRegistryToken(params: {
  organizationId: string;
  actorUserId: string;
  name: string;
  expiresAt?: number;
}): Promise<WorkshopRegistryTokenSummary & { token: string }> {
  await requireOwner(params.organizationId, params.actorUserId);
  const name = params.name.trim();
  if (!name || name.length > 80) {
    throw appError(
      400,
      "invalid_workshop_registry_token_name",
      "token name must be between 1 and 80 characters",
    );
  }
  const now = Date.now();
  const expiresAt = params.expiresAt ?? now + DEFAULT_TOKEN_LIFETIME_MS;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_TOKEN_LIFETIME_MS
  ) {
    throw appError(
      400,
      "invalid_workshop_registry_token_expiry",
      "token expiry must be in the future and no more than 366 days away",
    );
  }

  const token = createOpaqueToken();
  const tokenHash = await hashWorkshopRegistryToken(token);
  const id = createAppId();
  const tokenPrefix = token.slice(0, TOKEN_PREFIX.length + 10);
  const db = drizzle(env.DB);
  const inserted = await db
    .insert(workshopRegistryTokens)
    .select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          organizationId: member.organizationId,
          name: sql<string>`${name}`.as("name"),
          tokenPrefix: sql<string>`${tokenPrefix}`.as("token_prefix"),
          tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
          createdBy: member.userId,
          lastUsedAt: sql<number | null>`NULL`.as("last_used_at"),
          expiresAt: sql<number>`${expiresAt}`.as("expires_at"),
          revokedAt: sql<number | null>`NULL`.as("revoked_at"),
          createdAt: sql<number>`${now}`.as("created_at"),
        })
        .from(member)
        .innerJoin(
          accessAllowlist,
          and(
            eq(accessAllowlist.userId, member.userId),
            eq(accessAllowlist.state, "active"),
          ),
        )
        .where(
          and(
            eq(member.organizationId, params.organizationId),
            eq(member.userId, params.actorUserId),
            eq(member.role, "owner"),
          ),
        ),
    )
    .returning({ id: workshopRegistryTokens.id });
  if (!inserted[0]) {
    throw appError(
      403,
      "beta_access_revoked",
      "active beta access is required to create a registry token",
    );
  }
  return {
    id,
    name,
    tokenPrefix,
    token,
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  };
}

export async function listWorkshopRegistryTokens(params: {
  organizationId: string;
  actorUserId: string;
}): Promise<WorkshopRegistryTokenSummary[]> {
  await requireOwner(params.organizationId, params.actorUserId);
  return drizzle(env.DB)
    .select({
      id: workshopRegistryTokens.id,
      name: workshopRegistryTokens.name,
      tokenPrefix: workshopRegistryTokens.tokenPrefix,
      lastUsedAt: workshopRegistryTokens.lastUsedAt,
      expiresAt: workshopRegistryTokens.expiresAt,
      revokedAt: workshopRegistryTokens.revokedAt,
      createdAt: workshopRegistryTokens.createdAt,
    })
    .from(workshopRegistryTokens)
    .where(eq(workshopRegistryTokens.organizationId, params.organizationId))
    .orderBy(desc(workshopRegistryTokens.createdAt));
}

export async function revokeWorkshopRegistryToken(params: {
  organizationId: string;
  actorUserId: string;
  tokenId: string;
}): Promise<void> {
  await requireOwner(params.organizationId, params.actorUserId);
  const db = drizzle(env.DB);
  const updated = await db
    .update(workshopRegistryTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(workshopRegistryTokens.id, params.tokenId),
        eq(workshopRegistryTokens.organizationId, params.organizationId),
        isNull(workshopRegistryTokens.revokedAt),
      ),
    )
    .returning({ id: workshopRegistryTokens.id });
  if (updated.length) return;

  const existing = await db
    .select({
      id: workshopRegistryTokens.id,
      revokedAt: workshopRegistryTokens.revokedAt,
    })
    .from(workshopRegistryTokens)
    .where(
      and(
        eq(workshopRegistryTokens.id, params.tokenId),
        eq(workshopRegistryTokens.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  if (existing[0]?.revokedAt !== null && existing[0]?.revokedAt !== undefined) {
    return;
  }
  throw appError(
    404,
    "workshop_registry_token_not_found",
    "workshop registry token not found",
  );
}

export async function hashWorkshopRegistryToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createOpaqueToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const body = [...random]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${TOKEN_PREFIX}${body}`;
}

async function requireOwner(
  organizationId: string,
  userId: string,
): Promise<void> {
  const role = await requireOrganizationRole({ organizationId, userId });
  if (role !== "owner") {
    throw appError(
      403,
      "organization_owner_required",
      "organization owner role required",
    );
  }
}
