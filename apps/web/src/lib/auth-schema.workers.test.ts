import {
  SchemaMismatchError,
  schemaCheckFor,
} from "@better-auth/core/db/internal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expect, it } from "vitest";
import { db } from "../db/client";
import * as schema from "../db/schema";
import { auth } from "./auth";

// Better Auth registers its schema check on the adapter it creates, and the
// OIDC SSO proxy in front of that adapter hides it, so a Better Auth upgrade
// that expects new columns would otherwise fail only on the first write.
it("has every column Better Auth expects", async () => {
  const { options } = await auth.$context;
  const check = schemaCheckFor(
    drizzleAdapter(db, { provider: "sqlite", schema })(options),
  );
  expect(check).toBeDefined();
  const findings = await Promise.resolve(check?.()).then(
    () => [],
    (error: unknown) => {
      if (!(error instanceof SchemaMismatchError)) throw error;
      return error.findings;
    },
  );
  expect(findings).toEqual([
    // The jwt plugin's adapter in auth.ts maps these fixed values instead.
    { kind: "missing-column", table: "jwks", column: "alg" },
    { kind: "missing-column", table: "jwks", column: "crv" },
  ]);
});
