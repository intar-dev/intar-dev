/// <reference path="../.astro/types.d.ts" />
/// <reference path="../worker-configuration.d.ts" />
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
      AGENT_JWT_SECRET: string;
      BETTER_AUTH_SECRET: string;
      BETA_MAINTENANCE_BYPASS_SECRET: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      STARGATE_ADMIN_BASE_URL?: string;
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

declare module "*.hcl?raw" {
  const content: string;
  export default content;
}

declare module "*.wasm?module" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

export {};
