/// <reference path="../.astro/types.d.ts" />
/// <reference path="../worker-configuration.d.ts" />
/// <reference types="@cloudflare/workers-types" />

import type { Session, User } from "better-auth";

declare global {
  namespace App {
    interface Locals {
      user: User | null;
      session: Session | null;
      /**
       * The Cloudflare execution context for this request, set by the
       * @astrojs/cloudflare adapter. Pass background work to its waitUntil so
       * the response is not held open for it.
       */
      cfContext?: ExecutionContext;
    }
  }

  namespace Cloudflare {
    interface Env {
      AGENT_JWT_SECRET: string;
      BETTER_AUTH_SECRET: string;
      CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      STARGATE_ADMIN_BASE_URL?: string;
      STARGATE_ADMIN_AUTH_SECRET: string;
      /**
       * Verified ABI 2 cutover pin from the release bundle. Required: the
       * runtime has no dynamic channel fallback. The deploy injects it.
       */
      SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON: string;
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
