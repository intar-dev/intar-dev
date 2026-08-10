import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";

export async function resolveBetaOidcProvider(
  organizationSlug: string,
): Promise<{ providerId: string; organizationSlug: string }> {
  const slug = organizationSlug.trim();
  if (!slug || slug.length > 128 || !/^[a-z0-9][a-z0-9-]*$/u.test(slug)) {
    throw appError(
      400,
      "invalid_organization_slug",
      "organization slug is invalid",
    );
  }
  const provider = await env.DB.prepare(
    `SELECT provider.provider_id AS providerId
     FROM sso_provider AS provider
     INNER JOIN organization AS tenant
       ON tenant.id = provider.organization_id
     WHERE tenant.slug = ?1
       AND provider.domain_verified = 1
       AND provider.oidc_config IS NOT NULL
     LIMIT 1`,
  )
    .bind(slug)
    .first<{ providerId: string }>();
  if (!provider) {
    throw appError(
      404,
      "organization_sso_unavailable",
      "organization SSO recovery is unavailable",
    );
  }
  return { ...provider, organizationSlug: slug };
}
