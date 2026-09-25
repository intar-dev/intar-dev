import { env } from "cloudflare:workers";
import { vi } from "vitest";

/**
 * Runs `action` just before the first statement whose SQL matches `pattern`
 * executes, as if another request committed right then. Only for statements
 * run on their own; a D1 batch needs the real statement objects.
 */
export function interleaveBefore(
  pattern: RegExp,
  action: () => Promise<unknown>,
): { fired(): boolean; restore(): void } {
  const prepare = env.DB.prepare.bind(env.DB);
  let armed = true;
  let pending: Promise<unknown> | null = null;
  const runAction = () => (pending ??= action());
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (typeof value !== "function") return value;
        if (["run", "all", "raw", "first"].includes(String(property))) {
          return async (...args: unknown[]) => {
            await runAction();
            return (value as (...args: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
  const spy = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    if (!armed || !pattern.test(query)) return statement;
    armed = false;
    return wrap(statement);
  });
  return {
    fired: () => pending !== null,
    restore: () => spy.mockRestore(),
  };
}
