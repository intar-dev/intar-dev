/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { runtimeOperationGates } from "@/db/schema";
import {
  assertAgentKvmRunsOpen,
  IMAGE_CUTOVER_GATE,
} from "@/lib/run-admission-gate";
import { handleImageCutoverGate } from "@/control-plane/image-registry/cutover-gate";
import { resetD1Database } from "@/test/d1-migrations";

describe("agent-KVM run admission gate", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("blocks general runs but permits an explicit admin proof while drained", async () => {
    await drizzle(env.DB).insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
      updatedAt: Date.now(),
    });

    await expect(assertAgentKvmRunsOpen(env.DB)).rejects.toMatchObject({
      status: 503,
      code: "runtime_cutover_drained",
    });
    await expect(
      assertAgentKvmRunsOpen(env.DB, { allowDrainedAdminProof: true }),
    ).resolves.toBeUndefined();
  });

  it("lets a drain end the wipe hold, so an admin proof can run before learners", async () => {
    await drizzle(env.DB).insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "wiped",
      updatedAt: Date.now(),
    });
    await expect(
      assertAgentKvmRunsOpen(env.DB, { allowDrainedAdminProof: true }),
    ).rejects.toMatchObject({ code: "runtime_cutover_drained" });

    const response = await handleImageCutoverGate(
      new Request("https://intar.test/gate", {
        method: "POST",
        headers: { authorization: "Bearer test-publish-token" },
        body: JSON.stringify({ state: "drained" }),
      }),
      env,
    );
    expect(await response.json()).toMatchObject({ state: "drained", wiped: false });

    await expect(
      assertAgentKvmRunsOpen(env.DB, { allowDrainedAdminProof: true }),
    ).resolves.toBeUndefined();
    await expect(assertAgentKvmRunsOpen(env.DB)).rejects.toMatchObject({
      code: "runtime_cutover_drained",
    });
  });

  it("keeps normal and admin proof runs open when the gate is open", async () => {
    await drizzle(env.DB).insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "open",
      updatedAt: Date.now(),
    });

    await expect(assertAgentKvmRunsOpen(env.DB)).resolves.toBeUndefined();
    await expect(
      assertAgentKvmRunsOpen(env.DB, { allowDrainedAdminProof: true }),
    ).resolves.toBeUndefined();
  });
});
