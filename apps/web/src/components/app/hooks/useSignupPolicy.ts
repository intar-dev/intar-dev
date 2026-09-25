import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationResponse } from "../pages/organization-detail/types";

/**
 * Sets whether an organization's provider may create accounts for other email
 * domains. Organization settings and the admin list both show the policy, so
 * both refresh.
 */
export function useSignupPolicy(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (allowExternalEmailSignups: boolean) => {
      const response = await fetch(
        `/api/admin/organizations/${encodeURIComponent(organizationId)}/sso-policy`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowExternalEmailSignups }),
        },
      );
      await mutationResponse(response, "Failed to save the sign-up policy");
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["organizations", organizationId, "oidc"],
        }),
        // The admin list only; the policy can't change who was removed.
        queryClient.invalidateQueries({
          queryKey: ["admin", "organizations"],
          exact: true,
        }),
      ]),
  });
}

/** How the policy reads, and the button that changes it. */
export function signupPolicyText(domain: string, allowExternal: boolean) {
  return allowExternal
    ? {
        status: `Sign-ups may use any email the identity provider verified, not only ${domain}.`,
        action: `Limit to ${domain}`,
      }
    : {
        status: `Sign-ups are limited to emails on ${domain}.`,
        action: "Allow other email domains",
      };
}
