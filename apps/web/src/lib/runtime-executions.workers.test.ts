import { describe, expect, it, vi } from "vitest";
import { drizzleQueryToD1Statement } from "@/lib/runtime-executions";

describe("scenario runtime statement adapter", () => {
  it("passes compiled SQL and parameters to D1", () => {
    const bind = vi.fn(() => "statement");
    const prepare = vi.fn(() => ({ bind }));
    const result = drizzleQueryToD1Statement(
      { prepare } as unknown as D1Database,
      { toSQL: () => ({ sql: "select ?", params: ["scenario-1"] }) },
    );

    expect(prepare).toHaveBeenCalledWith("select ?");
    expect(bind).toHaveBeenCalledWith("scenario-1");
    expect(result).toBe("statement");
  });
});
