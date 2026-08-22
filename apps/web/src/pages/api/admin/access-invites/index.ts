import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  createAccessInvite,
  listAccessInvites,
  listBetaUsers,
} from "@/lib/access-invites";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { canonicalApplicationOrigin } from "@/lib/request-security";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return accessInviteNoStore(authz.response);

  try {
    const [invites, betaUsers] = await Promise.all([
      listAccessInvites({ d1: env.DB }),
      listBetaUsers({ d1: env.DB }),
    ]);
    return accessInviteJson({ invites, betaUsers });
  } catch (error) {
    return accessInviteError(error, "beta access could not be listed");
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const body = await readJsonObject(request);
    const label =
      body.label === null || typeof body.label === "string"
        ? body.label
        : undefined;
    const created = await createAccessInvite({
      d1: env.DB,
      kind: "standard",
      actorUserId: authz.context.userId,
      ...(label !== undefined ? { label } : {}),
    });
    const { code, ...invite } = created;
    return accessInviteJson(
      {
        invite,
        inviteUrl: `${canonicalApplicationOrigin()}/join#invite=${encodeURIComponent(code)}`,
      },
      { status: 201 },
    );
  } catch (error) {
    return accessInviteError(error, "the beta invite could not be created");
  }
};
