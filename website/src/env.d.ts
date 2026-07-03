/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

import type { Session, User } from "better-auth";

declare global {
  namespace App {
    interface Locals {
      user: User | null;
      session: Session | null;
    }
  }

  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ALLOWLIST: KVNamespace;
      HOST_RUNTIME: DurableObjectNamespace;
      VM_IMAGE_REGISTRY_BUCKET: R2Bucket;
      VM_RUN_ARTIFACTS_BUCKET: R2Bucket;
      STARGATE_ADMIN_SERVICE: Fetcher;
      AGENT_JWT_AUDIENCE?: string;
      AGENT_JWT_ISSUER?: string;
      AGENT_JWT_SECRET: string;
      BETTER_AUTH_APP_NAME?: string;
      BETTER_AUTH_SECRET: string;
      BETTER_AUTH_URL: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      STARGATE_ADMIN_BASE_URL?: string;
      STARGATE_ROUTE_TTL_SECONDS?: string;
      STARGATE_ADMIN_AUTH_HEADER?: string;
      STARGATE_ADMIN_AUTH_ISSUER: string;
      STARGATE_ADMIN_AUTH_AUDIENCE: string;
      STARGATE_ADMIN_AUTH_SECRET: string;
      SCENARIO_RUN_KEY_ENCRYPTION_SECRET: string;
      REGISTRY_PUBLISH_TOKEN: string;
    }
  }
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

export {};
