import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  createUserSshKeyForUser,
  listUserSshKeysForUser,
} from "@/lib/user-ssh-keys";
import { revokeScenarioNativeProfileRoutesForUser } from "@/lib/scenario-runs";

interface CreateUserSshKeyBody {
  label?: unknown;
  publicKey?: unknown;
}

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const keys = await listUserSshKeysForUser(authz.context.userId);
    return jsonResponse({ keys });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load SSH keys");
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  let body: CreateUserSshKeyBody;
  try {
    body = (await request.json()) as CreateUserSshKeyBody;
  } catch {
    return jsonResponse({ error: "invalid json body" }, { status: 400 });
  }

  try {
    const key = await createUserSshKeyForUser({
      userId: authz.context.userId,
      label: typeof body.label === "string" ? body.label : null,
      publicKey: typeof body.publicKey === "string" ? body.publicKey : "",
    });
    await revokeScenarioNativeProfileRoutesForUser(authz.context.userId).catch(
      (error) => {
        console.error("failed to revoke native profile routes after key create", error);
      },
    );
    return jsonResponse({ key }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to save SSH key");
    return jsonResponse(body, { status });
  }
};
