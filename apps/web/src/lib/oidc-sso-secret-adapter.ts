import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";
import {
  decryptOidcClientSecret,
} from "./oidc-sso-secret";

const SSO_PROVIDER_MODEL = "ssoProvider";
const SSO_PROVIDER_CIPHERTEXT_FIELD = "oidcClientSecretCiphertext";
const RESULT_METHODS = new Set([
  "create",
  "findOne",
  "findMany",
  "update",
  "consumeOne",
  "incrementOne",
]);
const SSO_WRITE_METHODS = new Set([
  "create",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
]);

export type OidcSsoSecretAdapterRuntime = {
  encryptionKey: string | undefined;
};

export class OidcSsoProviderWriteDisabledError extends Error {
  constructor() {
    super("SSO provider writes are disabled in Better Auth");
    this.name = "OidcSsoProviderWriteDisabledError";
  }
}

export class OidcSsoProviderSecretUnavailableError extends Error {
  constructor() {
    super("OIDC provider configuration is unavailable");
    this.name = "OidcSsoProviderSecretUnavailableError";
  }
}

export function decorateOidcSsoSecretAdapter(
  adapter: DBAdapter,
  getRuntime: () => OidcSsoSecretAdapterRuntime,
): DBAdapter {
  return decorateAdapter(adapter, getRuntime);
}

export function createOidcSsoSecretAdapterFactory<Options>(
  factory: (options: Options) => DBAdapter,
  getRuntime: () => OidcSsoSecretAdapterRuntime,
): (options: Options) => DBAdapter {
  return (options) => decorateOidcSsoSecretAdapter(factory(options), getRuntime);
}

function decorateAdapter<T extends DBAdapter | DBTransactionAdapter>(
  adapter: T,
  getRuntime: () => OidcSsoSecretAdapterRuntime,
): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "transaction" && typeof value === "function") {
        return async <Result>(
          callback: (transaction: DBTransactionAdapter) => Promise<Result>,
        ): Promise<Result> =>
          Reflect.apply(
            value as (...args: never[]) => unknown,
            target,
            [
              async (transaction: DBTransactionAdapter) =>
                callback(decorateAdapter(transaction, getRuntime)),
            ],
          ) as Promise<Result>;
      }
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }

      return async (...args: unknown[]) => {
        const model = adapterModel(args[0]);
        if (
          model === SSO_PROVIDER_MODEL &&
          SSO_WRITE_METHODS.has(property) &&
          !isIdentityPreservingProviderLock(property, args[0])
        ) {
          throw new OidcSsoProviderWriteDisabledError();
        }
        const result = await Reflect.apply(
          value as (...args: never[]) => unknown,
          target,
          args as never[],
        );
        return RESULT_METHODS.has(property)
          ? hydrateAdapterResult(model, result, getRuntime)
          : result;
      };
    },
  }) as T;
}

async function hydrateAdapterResult(
  model: string | null,
  result: unknown,
  getRuntime: () => OidcSsoSecretAdapterRuntime,
): Promise<unknown> {
  if (model !== SSO_PROVIDER_MODEL) return result;
  if (Array.isArray(result)) {
    return Promise.all(
      result.map((provider) => hydrateSsoProvider(provider, getRuntime)),
    );
  }
  return hydrateSsoProvider(result, getRuntime);
}

async function hydrateSsoProvider(
  provider: unknown,
  getRuntime: () => OidcSsoSecretAdapterRuntime,
): Promise<unknown> {
  if (!isRecord(provider)) return stripCiphertext(provider);
  const ciphertext = provider[SSO_PROVIDER_CIPHERTEXT_FIELD];
  const sanitized = stripCiphertext(provider);
  if (!isRecord(sanitized) || typeof sanitized.oidcConfig !== "string") {
    return sanitized;
  }
  const config = parseOidcConfig(sanitized.oidcConfig);
  const runtime = getRuntime();
  if (typeof ciphertext !== "string" || !ciphertext) {
    throw new OidcSsoProviderSecretUnavailableError();
  }

  const id = typeof sanitized.id === "string" ? sanitized.id : null;
  const providerId =
    typeof sanitized.providerId === "string" ? sanitized.providerId : null;
  const organizationId =
    typeof sanitized.organizationId === "string"
      ? sanitized.organizationId
      : null;
  if (!id || !providerId || !organizationId) {
    throw new OidcSsoProviderSecretUnavailableError();
  }

  let clientSecret: string;
  try {
    clientSecret = await decryptOidcClientSecret({
      encryptionKey: runtime.encryptionKey,
      ciphertext,
      identity: { id, providerId, organizationId },
    });
  } catch {
    throw new OidcSsoProviderSecretUnavailableError();
  }
  return {
    ...sanitized,
    oidcConfig: JSON.stringify({ ...config, clientSecret }),
  };
}

function parseOidcConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // The adapter turns invalid stored configuration into one stable failure.
  }
  throw new OidcSsoProviderSecretUnavailableError();
}

function stripCiphertext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCiphertext);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === SSO_PROVIDER_CIPHERTEXT_FIELD) continue;
    result[key] = stripCiphertext(nested);
  }
  return result;
}

function adapterModel(value: unknown): string | null {
  if (!isRecord(value) || typeof value.model !== "string") return null;
  return value.model;
}

function isIdentityPreservingProviderLock(
  method: string,
  value: unknown,
): boolean {
  if (method !== "update" || !isRecord(value) || !isRecord(value.update)) {
    return false;
  }
  const updateKeys = Object.keys(value.update);
  const providerId = value.update.providerId;
  if (
    updateKeys.length !== 1 ||
    updateKeys[0] !== "providerId" ||
    typeof providerId !== "string" ||
    !Array.isArray(value.where) ||
    value.where.length !== 1 ||
    !isRecord(value.where[0])
  ) {
    return false;
  }
  const where = value.where[0];
  return (
    where.field === "providerId" &&
    where.value === providerId &&
    (where.operator === undefined || where.operator === "eq") &&
    (where.connector === undefined || where.connector === "AND")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
