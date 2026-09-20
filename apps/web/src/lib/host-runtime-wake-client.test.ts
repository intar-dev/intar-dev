import { expect, it, vi } from "vitest";
import { tryWakeHostRuntimeViaNamespace, wakeHostRuntimeViaNamespace } from "./host-runtime-wake-client";

function namespace(status: number) {
  return {
    idFromName: vi.fn().mockReturnValue("host-id"),
    get: vi.fn().mockReturnValue({ fetch: vi.fn().mockResolvedValue(new Response(null, { status })) }),
  } as unknown as DurableObjectNamespace;
}

it("accepts an acknowledged wake", async () => {
  await expect(wakeHostRuntimeViaNamespace(namespace(202), "host")).resolves.toBeUndefined();
});

it.each([400, 404, 500, 503])("rejects an unsuccessful wake response (%s)", async status => {
  await expect(wakeHostRuntimeViaNamespace(namespace(status), "host"))
    .rejects.toThrow(`host runtime wake failed for host: ${status}`);
});

it("keeps a best-effort wake nonfatal and reports its failure", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(tryWakeHostRuntimeViaNamespace(namespace(500), "host")).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
  } finally { warning.mockRestore(); }
});
