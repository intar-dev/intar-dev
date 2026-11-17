import { vi } from "vitest";

const authMock = vi.hoisted(() => ({
  requireVerifiedAgentRequest: vi.fn(),
}));

const dbMock = vi.hoisted(() => {
  const db = { kind: "test-db" };
  return {
    db,
    drizzle: vi.fn(() => db),
  };
});

export function imageRegistryMocks() {
  return { authMock, dbMock };
}

vi.mock("@/control-plane/auth", () => authMock);

vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));

vi.mock("cloudflare:workers", () => ({ env: {} }));

export function resetImageRegistryMocks(): void {
  authMock.requireVerifiedAgentRequest.mockReset();
  dbMock.drizzle.mockReset();
  dbMock.drizzle.mockImplementation(() => dbMock.db);
}

export function bundleDownloadDb(rows: Array<{ id: string; r2Key: string }>) {
  const selectLimit = vi.fn().mockResolvedValue(rows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({ innerJoin: selectInnerJoin }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}
