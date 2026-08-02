import { env } from "cloudflare:workers";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import type { Session, User } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, organization, username } from "better-auth/plugins";
import * as schema from "../db/schema";
import { db } from "../db/client";
import {
  isAllowlisted,
  isValidGithubUsername,
  toAllowlistKey,
} from "./allowlist";
import { getUserRole, isAdminRole } from "./authz";
import { createAppId } from "./id";
import {
  canCreateOrganization,
  hasReachedOwnedOrganizationLimit,
} from "./organization-access";

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

const isSsoCallback = (context: unknown): boolean => {
  if (typeof context !== "object" || context === null) return false;
  const path = "path" in context ? context.path : undefined;
  return typeof path === "string" && path.startsWith("/sso/callback/");
};

const getOAuthRoleClaims = (user: User, scopes: readonly string[]) => {
  if (!scopes.includes("roles")) {
    return {};
  }

  const role =
    getUserRole(user as { role?: string | null | undefined }) ?? "user";

  return {
    role,
    roles: [role],
  };
};

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
    customIdTokenClaims: ({ user, scopes }) => getOAuthRoleClaims(user, scopes),
  }) as unknown as BetterAuthPlugin;

  return betterAuth({
    appName:
      runtimeEnv?.BETTER_AUTH_APP_NAME ??
      env.BETTER_AUTH_APP_NAME ??
      "Astro App",
    baseURL,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    trustedOrigins: async () => trustedSsoOrigins(),
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/email",
      "/delete-user",
      "/delete-user/callback",
      "/admin/remove-user",
      "/organization/create",
      "/organization/update",
      "/organization/delete",
      "/organization/leave",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/remove-member",
      "/organization/update-member-role",
      "/organization/create-role",
      "/organization/update-role",
      "/organization/delete-role",
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
    ],
    emailAndPassword: {
      enabled: false,
      disableSignUp: true,
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
          before: async (user: UserWithUsername, context) => {
            const username = getUsername(user);
            if (!username && isSsoCallback(context)) return;
            if (!username || !(await isAllowlisted(username))) return false;
            return;
          },
        },
      },
      session: {
        create: {
          before: async (session: Session, context) => {
            if (!context) {
              return false;
            }

            const user = (await context.context.adapter.findOne({
              model: "user",
              where: [{ field: "id", value: session.userId }],
            })) as UserWithUsername | null;
            if (isSsoCallback(context)) return;
            if (!(await isAllowlisted(getUsername(user)))) return false;
            return;
          },
        },
      },
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        usernameValidator: isValidGithubUsername,
        usernameNormalization: (value) => toAllowlistKey(value) ?? value,
        validationOrder: { username: "post-normalization" },
        immutableUsername: true,
      }),
      admin(),
      organization({
        allowUserToCreateOrganization: async (user) =>
          canCreateOrganization(user.id),
        organizationLimit: async (user) =>
          hasReachedOwnedOrganizationLimit(user.id),
      }),
      sso({
        providersLimit: 0,
        domainVerification: {
          enabled: true,
          tokenPrefix: "intar-oidc",
        },
        // The verified provider, not the user's email suffix, owns access.
        // Custom provisioning also prevents an ordinary GitHub callback from
        // joining an organization through the SSO plugin's domain hook.
        organizationProvisioning: { disabled: true },
        provisionUserOnEveryLogin: true,
        provisionUser: async ({ user, provider }) => {
          if (!provider.organizationId) return;
          await db
            .insert(schema.member)
            .values({
              id: createAppId(),
              organizationId: provider.organizationId,
              userId: user.id,
              role: "member",
              createdAt: new Date(),
            })
            .onConflictDoNothing({
              target: [schema.member.organizationId, schema.member.userId],
            });
        },
      }),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          jwksPath: "/.well-known/jwks.json",
        },
      }),
      oauthProviderPlugin,
    ],
    secret: runtimeEnv?.BETTER_AUTH_SECRET ?? env.BETTER_AUTH_SECRET,
  });
}

async function trustedSsoOrigins(): Promise<string[]> {
  const origins = new Set<string>();
  const appOrigin = safeOrigin(baseURL);
  if (appOrigin) origins.add(appOrigin);

  const providers = await db
    .select({
      issuer: schema.ssoProvider.issuer,
      oidcConfig: schema.ssoProvider.oidcConfig,
    })
    .from(schema.ssoProvider);

  for (const provider of providers) {
    const issuerOrigin = safeOrigin(provider.issuer);
    if (issuerOrigin) origins.add(issuerOrigin);
    const config = parseJsonRecord(provider.oidcConfig);
    for (const key of [
      "discoveryEndpoint",
      "authorizationEndpoint",
      "tokenEndpoint",
      "userInfoEndpoint",
      "jwksEndpoint",
    ]) {
      const value = config?.[key];
      const origin = typeof value === "string" ? safeOrigin(value) : null;
      if (origin) origins.add(origin);
    }
  }

  return [...origins];
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type AuthInstance = ReturnType<typeof buildAuthInstance>;

let authInstance: AuthInstance | null = null;

function getAuthInstance(): AuthInstance {
  if (!authInstance) {
    authInstance = buildAuthInstance();
  }
  return authInstance;
}

export const auth = new Proxy({} as AuthInstance, {
  get(_target, prop, receiver) {
    const instance = getAuthInstance() as object;
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
}) as AuthInstance;
