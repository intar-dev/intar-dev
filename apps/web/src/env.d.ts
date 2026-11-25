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
      SCENARIO_RUN_KEY_ENCRYPTION_SECRET: string;
      REGISTRY_PUBLISH_TOKEN: string;
      /**
       * The intar-image-cli release the compiler descriptor names, and its
       * release tarball sha256 per target as JSON, e.g. {"linux_amd64":"<hex>"}.
       * While either is empty the descriptor answers 503. The deploy injects
       * both from the newest attested release that compiles the current
       * source format (tools/deploy/release-pins.ts).
       */
      SCENARIO_COMPILER_CLI_VERSION?: string;
      SCENARIO_COMPILER_CLI_SHA256?: string;
      /**
       * The desktop app's release an installed app is offered as its update,
       * with the SHA-256 of its download:
       * {"macos_arm64":{"version":"X.Y.Z","sha256":"<hex>"}}. Empty: the app
       * is offered none. The deploy injects the newest release that main's
       * release workflow attested, and the app checks its download by this
       * digest, so a replaced download is refused.
       */
      JUMPER_RELEASE_JSON?: string;
      /**
       * The Kino pins per guest contract, as
       * `{"<contract>":{"current":"sha256:<hex>","previous":"sha256:<hex>"|null}}`.
       * The deploy injects it; without it no host has a Kino pin.
       */
      KINO_PINS_JSON?: string;
      /**
       * The release of each pinned Kino artifact, as JSON: what the compiler
       * descriptor names for a pipeline's boot check. The deploy injects it
       * with the pin.
       */
      KINO_RELEASES_JSON?: string;
    }
  }
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

export {};
