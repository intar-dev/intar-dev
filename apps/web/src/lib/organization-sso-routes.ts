import { accessInviteJson, readJsonObject } from "@/lib/access-invite-http";
import { resolveOrganizationOidcProvider } from "@/lib/access-sso";
import { appError } from "@/lib/app-error";
import { startOrganizationSso } from "@/lib/organization-sso-start";
import { canonicalApplicationOrigin } from "@/lib/request-security";

/**
 * The organization a start route's body names: its provider, and its page on
 * the canonical origin. Client-supplied URLs are never used.
 */
export async function readOrganizationSsoTarget(request: Request): Promise<{
  body: Record<string, unknown>;
  providerId: string;
  organizationId: string;
  organizationURL: string;
}> {
  const body = await readJsonObject(request);
  if (typeof body.organizationSlug !== "string") {
    throw appError(
      400,
      "organization_slug_required",
      "organization slug is required",
    );
  }
  const provider = await resolveOrganizationOidcProvider(body.organizationSlug);
  return {
    body,
    providerId: provider.providerId,
    organizationId: provider.organizationId,
    organizationURL: `${canonicalApplicationOrigin()}/organizations/${encodeURIComponent(provider.organizationSlug)}`,
  };
}

/** Starts the flow; the browser goes to the returned URL next. */
export async function organizationSsoStartResponse(
  input: Parameters<typeof startOrganizationSso>[0],
): Promise<Response> {
  const started = await startOrganizationSso(input);
  return accessInviteJson(
    { redirectUrl: started.redirectUrl },
    { headers: started.headers },
  );
}
