import { env } from "cloudflare:workers";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import type { Session, User } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, testUtils, username } from "better-auth/plugins";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { isAllowlisted } from "./allowlist";
import { getUserRole, isAdminRole } from "./authz";

const runtimeEnv =
  "process" in globalThis
    ? (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env
    : undefined;

const baseURL =
  runtimeEnv?.BETTER_AUTH_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:4321";


const oauthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "roles",
] as const;

const oauthAdvertisedClaims = [
  "sub",
  "iss",
  "aud",
  "exp",
  "iat",
  "sid",
  "scope",
  "azp",
  "email",
  "email_verified",
  "name",
  "picture",
  "family_name",
  "given_name",
  "role",
  "roles",
] as const;

type UserWithUsername = User & { username?: string | null };

const getUsername = (candidate?: UserWithUsername | null) =>
  candidate?.username ?? null;

const getOAuthRoleClaims = (user: User, scopes: readonly string[]) => {
  if (!scopes.includes("roles")) {
    return {};
  }

  const role = getUserRole(user as { role?: string | null | undefined }) ?? "user";

  return {
    role,
    roles: [role],
  };
};


interface AuthRuntimeConfig {
  allowContextlessSessionCreate: boolean;
  extraPlugins: BetterAuthPlugin[];
}

const defaultAuthRuntimeConfig = (): AuthRuntimeConfig => ({
  allowContextlessSessionCreate: false,
  extraPlugins: [],
});

let authRuntimeConfig = defaultAuthRuntimeConfig();

function buildAuthInstance() {
  const oauthProviderPlugin = oauthProvider({
    loginPage: "/",
    consentPage: "/oauth/consent",
    scopes: [...oauthScopes],
    grantTypes: ["authorization_code", "refresh_token"],
    silenceWarnings: {
      oauthAuthServerConfig: true,
      openidConfig: true,
    },
    advertisedMetadata: {
      scopes_supported: [...oauthScopes],
      claims_supported: [...oauthAdvertisedClaims],
    },
    clientPrivileges: ({ user }) =>
      isAdminRole(
        getUserRole(user as { role?: string | null | undefined } | undefined),
      ),
    customUserInfoClaims: ({ user, scopes }) =>
      getOAuthRoleClaims(user, scopes),
    customIdTokenClaims: ({ user, scopes }) =>
      getOAuthRoleClaims(user, scopes),
  }) as unknown as BetterAuthPlugin;

  return betterAuth({
    appName:
      runtimeEnv?.BETTER_AUTH_APP_NAME ?? env.BETTER_AUTH_APP_NAME ?? "Astro App",
    baseURL,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      github: {
        clientId: runtimeEnv?.GITHUB_CLIENT_ID ?? env.GITHUB_CLIENT_ID,
        clientSecret:
          runtimeEnv?.GITHUB_CLIENT_SECRET ?? env.GITHUB_CLIENT_SECRET,
        mapProfileToUser: (profile) => ({
          username: profile.login,
          displayUsername: profile.login,
        }),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: UserWithUsername) => {
            if (!(await isAllowlisted(getUsername(user)))) return false;
            return;
          },
        },
      },
      session: {
        create: {
          before: async (session: Session, context) => {
            if (!context) {
              return authRuntimeConfig.allowContextlessSessionCreate
                ? undefined
                : false;
            }

            const user = (await context.context.adapter.findOne({
              model: "user",
              where: [{ field: "id", value: session.userId }],
            })) as UserWithUsername | null;
            if (!(await isAllowlisted(getUsername(user)))) return false;
            return;
          },
        },
      },
    },
    plugins: [
      username(),
      admin(),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          jwksPath: "/.well-known/jwks.json",
        },
      }),
      oauthProviderPlugin,
      ...authRuntimeConfig.extraPlugins,
    ],
    secret: runtimeEnv?.BETTER_AUTH_SECRET ?? env.BETTER_AUTH_SECRET,
  });
}

type AuthInstance = ReturnType<typeof buildAuthInstance>;

let authInstance: AuthInstance | null = null;

function getAuthInstance(): AuthInstance {
  if (!authInstance) {
    authInstance = buildAuthInstance();
  }
  return authInstance;
}

export function installAuthTestSupport(): void {
  authRuntimeConfig = {
    allowContextlessSessionCreate: true,
    extraPlugins: [testUtils({ captureOTP: true }) as unknown as BetterAuthPlugin],
  };
  authInstance = null;
}

export function resetAuthRuntimeConfig(): void {
  authRuntimeConfig = defaultAuthRuntimeConfig();
  authInstance = null;
}

export const auth = new Proxy({} as AuthInstance, {
  get(_target, prop, receiver) {
    const instance = getAuthInstance() as object;
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
}) as AuthInstance;
