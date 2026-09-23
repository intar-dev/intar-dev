import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), retire: vi.fn(), cleanup: vi.fn(), completed: vi.fn() }));
vi.mock("@/lib/agent-bridge", () => ({ requireUserContext: mocks.auth }));
vi.mock("@/lib/personal-host-retirement", () => ({ retirePersonalHost: mocks.retire }));
vi.mock("@/lib/host-workload-retirement", () => ({ cleanupRemovedHost: mocks.cleanup }));
vi.mock("@/lib/personal-servers", () => ({ updatePersonalServer: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { DB: { prepare: () => ({ bind: () => ({ run: mocks.completed }) }) } } }));
import { DELETE } from "@/pages/api/servers/[hostId]";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, context: { userId: "owner" } });
  mocks.retire.mockResolvedValue({ placement: "platform" });
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.completed.mockResolvedValue({ success: true });
});
function remove(body?: object) {
  return DELETE({ request: new Request("https://intar.dev/api/servers/host", {
    method: "DELETE", ...(body ? { body: JSON.stringify(body) } : {}),
  }), params: { hostId: "host" } } as never);
}
it("requires explicit removal input", async () => {
  expect((await remove()).status).toBe(400);
  expect(mocks.retire).not.toHaveBeenCalled();
});
it("lets an active owner remove a connected server and keeps physical cleanup honest", async () => {
  const response = await remove({ confirmReturnToCloud: true });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ removed: true, placement: "platform", physicalCleanup: "unconfirmed" });
  expect(mocks.retire).toHaveBeenCalledWith({ d1: expect.any(Object), userId: "owner", hostId: "host", confirmReturnToCloud: true });
  expect(mocks.cleanup).toHaveBeenCalledWith("host");
  expect(mocks.completed).toHaveBeenCalledOnce();
});
it("reports failed cleanup for a retry after durable revocation", async () => {
  mocks.cleanup.mockRejectedValue(new Error("gateway unavailable"));
  const response = await remove({ confirmReturnToCloud: true });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "server_cleanup_pending" });
  expect(mocks.retire).toHaveBeenCalledOnce();
  expect(mocks.completed).not.toHaveBeenCalled();
});
it("does not retire a host without an active user", async () => {
  mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await remove({ confirmReturnToCloud: true })).status).toBe(403);
  expect(mocks.retire).not.toHaveBeenCalled();
});
