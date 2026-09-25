import {
  createAuthClient,
  type InferSessionFromClient,
  type InferUserFromClient,
} from "better-auth/client";
import {
  adminClient,
  organizationClient,
  usernameClient,
} from "better-auth/client/plugins";
import { getClientAppBootstrap } from "./app-bootstrap";
export { getClientAppBootstrap };
export type { AppAccessState, AppBootstrapData } from "./app-bootstrap";

const authClientPlugins = [
  usernameClient(),
  adminClient(),
  organizationClient(),
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

/** A refused sign-in or connect request, with its app or Better Auth code. */
export class AuthFlowError extends Error {
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "AuthFlowError";
    this.code = code;
  }
}

/**
 * Continues with an organization's identity provider. Signed out, the
 * provider signs the person in and creates their account on first use.
 * `connect` (or `test`) connects the organization to the signed-in account
 * instead. The caller says which, as its page does: each route refuses the
 * other case, so a session that changed meanwhile never does what the page
 * didn't describe.
 */
export async function startOrganizationSignIn(
  organizationSlug: string,
  options: { connect: boolean; test?: boolean },
) {
  const slug = organizationSlug.trim();
  if (!slug) throw new Error("Organization slug is required");

  const connect = options.connect || options.test === true;
  const response = await fetch(
    connect ? "/api/account-links/sso/start" : "/api/organization-sign-in/start",
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationSlug: slug,
        ...(options.test ? { test: true } : {}),
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    redirectUrl?: unknown;
    error?: unknown;
    code?: unknown;
  } | null;
  if (connect && response.status === 401) {
    throw new AuthFlowError(
      "signed_out",
      options.test
        ? "Sign in again to test organization access."
        : "You're signed out now. Continue to sign in with your organization.",
    );
  }
  if (!response.ok || typeof body?.redirectUrl !== "string") {
    throw new AuthFlowError(
      typeof body?.code === "string" ? body.code : null,
      typeof body?.error === "string"
        ? body.error
        : "Organization sign-in failed",
    );
  }
  const redirectUrl = requireHttpsSsoRedirect(body.redirectUrl);
  window.location.assign(redirectUrl);
  return { redirectUrl };
}

/** Connects GitHub to the signed-in account; the result returns to Profile. */
export async function connectGithub() {
  const profileURL = `${window.location.origin}/profile`;
  const result = await authClient.linkSocial({
    provider: "github",
    callbackURL: profileURL,
    errorCallbackURL: profileURL,
  });
  if ("error" in result && result.error) {
    throw new AuthFlowError(
      typeof result.error.code === "string" ? result.error.code : null,
      result.error.message ?? "GitHub could not be connected",
    );
  }
  if ("data" in result && result.data?.url) {
    window.location.href = result.data.url;
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
