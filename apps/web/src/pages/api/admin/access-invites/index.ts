import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  createBetaInvite,
  listBetaInvites,
  listBetaUsers,
} from "@/lib/beta-invites";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return accessInviteNoStore(authz.response);

  try {
    const [invites, betaUsers] = await Promise.all([
      listBetaInvites({ d1: env.DB }),
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
    const created = await createBetaInvite({
      d1: env.DB,
      actorUserId: authz.context.userId,
      encryptionKey: env.ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1,
    });
    const { code: _rawCode, ...invite } = created;
    return accessInviteJson({ invite }, { status: 201 });
  } catch (error) {
    return accessInviteError(error, "the beta invite could not be created");
  }
};
