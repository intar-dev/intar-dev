import {
  createAuthClient,
  type InferSessionFromClient,
  type InferUserFromClient,
} from "better-auth/client";
import { ssoClient } from "@better-auth/sso/client";
import {
  adminClient,
  organizationClient,
  usernameClient,
} from "better-auth/client/plugins";

const authClientPlugins = [
  usernameClient(),
  adminClient(),
  organizationClient(),
  ssoClient({ domainVerification: { enabled: true } }),
];

const authClientOptions = {
  plugins: authClientPlugins,
};

export const authClient = createAuthClient(authClientOptions);

type BaseAppAuthSession = InferSessionFromClient<typeof authClientOptions>;
type BaseAppAuthUser = InferUserFromClient<typeof authClientOptions>;

export type AppAuthSession = BaseAppAuthSession & {
  impersonatedBy?: string | null | undefined;
  activeOrganizationId?: string | null | undefined;
};

export type AppAuthUser = BaseAppAuthUser & {
  username?: string | null | undefined;
  role?: string | null | undefined;
  banned?: boolean | null | undefined;
  banReason?: string | null | undefined;
  banExpires?: Date | null | undefined;
};

export interface AppSessionData {
  session: AppAuthSession;
  user: AppAuthUser;
}

export async function startOrganizationSignIn(
  organizationSlug: string,
  options?: {
    callbackURL?: string;
    errorCallbackURL?: string;
  },
) {
  const slug = organizationSlug.trim();
  if (!slug) throw new Error("Organization slug is required");

  const callbackURL =
    options?.callbackURL ??
    `${window.location.origin}/organizations/${encodeURIComponent(slug)}`;
  const errorCallbackURL =
    options?.errorCallbackURL ??
    `${window.location.origin}/organizations/${encodeURIComponent(slug)}/sign-in`;
  const session = await getClientSession();
  if (session) {
    const response = await fetch("/api/account-links/sso/start", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationSlug: slug }),
    });
    const body = (await response.json().catch(() => null)) as {
      redirectUrl?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok || typeof body?.redirectUrl !== "string") {
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : "Organization sign-in failed",
      );
    }
    const redirectUrl = requireHttpsSsoRedirect(body.redirectUrl);
    window.location.assign(redirectUrl);
    return { ...body, redirectUrl };
  }

  const result = await authClient.signIn.sso({
    organizationSlug: slug,
    callbackURL,
    errorCallbackURL,
    scopes: ["openid", "email", "profile", "offline_access"],
  });

  if ("error" in result && result.error) {
    throw new Error(result.error.message ?? "Organization sign-in failed");
  }

  if ("data" in result && result.data?.redirect && result.data.url) {
    window.location.assign(requireHttpsSsoRedirect(result.data.url));
  }

  return result;
}

function requireHttpsSsoRedirect(value: string): string {
  let redirect: URL;
  try {
    redirect = new URL(value, window.location.origin);
  } catch {
    throw new Error(
      "Organization identity provider returned an invalid redirect",
    );
  }
  if (redirect.protocol !== "https:") {
    throw new Error(
      "Organization identity provider returned an unsafe redirect",
    );
  }
  return redirect.href;
}

export async function getClientSession(): Promise<AppSessionData | null> {
  const result = await authClient.getSession();
  if ("error" in result && result.error) {
    throw new Error(result.error.message ?? "Failed to load session");
  }

  return "data" in result ? result.data : null;
}

export async function getClientBetaAccessState(): Promise<
  "active" | "restricted"
> {
  const response = await fetch("/api/access-invites/current", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as {
    state?: unknown;
  } | null;
  return response.ok && body?.state === "active" ? "active" : "restricted";
}

export async function startGithubSignIn(options?: {
  callbackURL?: string;
  errorCallbackURL?: string;
}) {
  const callbackURL =
    options?.callbackURL ?? `${window.location.origin}/courses`;
  const errorCallbackURL =
    options?.errorCallbackURL ?? `${window.location.origin}/`;
  const result = await authClient.signIn.social({
    provider: "github",
    callbackURL,
    errorCallbackURL,
  });

  if ("error" in result && result.error) {
    throw new Error(result.error.message ?? "Login failed");
  }

  if ("data" in result && result.data?.redirect && result.data.url) {
    window.location.href = result.data.url;
  }

  return result;
}
