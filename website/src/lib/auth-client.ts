import {
  createAuthClient,
  type InferSessionFromClient,
  type InferUserFromClient,
} from "better-auth/client";
import { adminClient, usernameClient } from "better-auth/client/plugins";

const authClientPlugins = [usernameClient(), adminClient()];

const authClientOptions = {
  plugins: authClientPlugins,
};

export const authClient = createAuthClient(authClientOptions);

type BaseAppAuthSession = InferSessionFromClient<typeof authClientOptions>;
type BaseAppAuthUser = InferUserFromClient<typeof authClientOptions>;

export type AppAuthSession = BaseAppAuthSession & {
  impersonatedBy?: string | null | undefined;
};

export type AppAuthUser = BaseAppAuthUser & {
  role?: string | null | undefined;
  banned?: boolean | null | undefined;
  banReason?: string | null | undefined;
  banExpires?: Date | null | undefined;
};

export interface AppSessionData {
  session: AppAuthSession;
  user: AppAuthUser;
}

export async function getClientSession(): Promise<AppSessionData | null> {
  const result = await authClient.getSession();
  if ("error" in result && result.error) {
    throw new Error(result.error.message ?? "Failed to load session");
  }

  return "data" in result ? result.data : null;
}

export async function startGithubSignIn(options?: {
  callbackURL?: string;
  errorCallbackURL?: string;
}) {
  const callbackURL =
    options?.callbackURL ?? `${window.location.origin}/scenarios`;
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
