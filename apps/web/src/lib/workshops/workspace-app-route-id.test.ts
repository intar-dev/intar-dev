import { describe, expect, it } from "vitest";
import {
  EFF_SHORT_WORDLIST_1,
  EFF_SHORT_WORDLIST_1_CARDINALITY,
} from "./eff-short-wordlist-1";
import {
  createWorkspaceAppRouteId,
  WORKSPACE_APP_ROUTE_ID_ENTROPY_BITS,
} from "./workspace-app-route-id";

describe("createWorkspaceAppRouteId", () => {
  it("uses exactly four EFF words and a canonical DNS label", () => {
    const routeId = createWorkspaceAppRouteId();
    const words = routeId.slice(3).split("-");

    expect(routeId).toMatch(/^wa-(?:[a-z0-9]{1,5}-){3}[a-z0-9]{1,5}$/);
    expect(words).toHaveLength(4);
    for (const word of words) {
      expect(EFF_SHORT_WORDLIST_1).toContain(word);
    }
  });

  it("rejects the biased uint16 tail before selecting words", () => {
    const unbiasedLimit =
      Math.floor(65_536 / EFF_SHORT_WORDLIST_1_CARDINALITY) *
      EFF_SHORT_WORDLIST_1_CARDINALITY;
    const values = [
      unbiasedLimit,
      0,
      EFF_SHORT_WORDLIST_1_CARDINALITY - 1,
      EFF_SHORT_WORDLIST_1_CARDINALITY,
      unbiasedLimit - 1,
    ];

    expect(createWorkspaceAppRouteId(() => values.shift()!)).toBe(
      `wa-${EFF_SHORT_WORDLIST_1[0]}-${EFF_SHORT_WORDLIST_1.at(-1)}-${EFF_SHORT_WORDLIST_1[0]}-${EFF_SHORT_WORDLIST_1.at(-1)}`,
    );
    expect(values).toHaveLength(0);
  });

  it("retains more than 41 bits of route identity entropy", () => {
    expect(EFF_SHORT_WORDLIST_1_CARDINALITY).toBe(1_295);
    expect(new Set(EFF_SHORT_WORDLIST_1).size).toBe(
      EFF_SHORT_WORDLIST_1_CARDINALITY,
    );
    for (const word of EFF_SHORT_WORDLIST_1) {
      expect(word).toMatch(/^[a-z0-9]{1,5}$/);
    }
    expect(EFF_SHORT_WORDLIST_1).toContain("yoyo");
    expect(EFF_SHORT_WORDLIST_1).not.toContain("yo-yo");
    expect(WORKSPACE_APP_ROUTE_ID_ENTROPY_BITS).toBeGreaterThan(41);
  });

  it("rejects an invalid injected random value", () => {
    expect(() => createWorkspaceAppRouteId(() => 65_536)).toThrow(RangeError);
  });
});
