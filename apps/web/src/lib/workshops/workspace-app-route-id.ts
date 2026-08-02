import {
  EFF_SHORT_WORDLIST_1,
  EFF_SHORT_WORDLIST_1_CARDINALITY,
} from "./eff-short-wordlist-1";

const ROUTE_WORD_COUNT = 4;
const UINT16_VALUE_COUNT = 65_536;
const UNBIASED_LIMIT =
  Math.floor(UINT16_VALUE_COUNT / EFF_SHORT_WORDLIST_1_CARDINALITY) *
  EFF_SHORT_WORDLIST_1_CARDINALITY;

function cryptographicUint16(): number {
  const value = new Uint16Array(1);
  crypto.getRandomValues(value);
  return value[0]!;
}

/**
 * Creates a random, human-readable route identity. It is not an authorization
 * secret: Stargate's bootstrap capability and route-bound cookie provide
 * authorization.
 */
export function createWorkspaceAppRouteId(
  randomUint16: () => number = cryptographicUint16,
): string {
  const words: string[] = [];
  while (words.length < ROUTE_WORD_COUNT) {
    const value = randomUint16();
    if (!Number.isInteger(value) || value < 0 || value >= UINT16_VALUE_COUNT) {
      throw new RangeError("randomUint16 must return an unsigned 16-bit integer");
    }
    if (value >= UNBIASED_LIMIT) continue;
    words.push(
      EFF_SHORT_WORDLIST_1[
        value % EFF_SHORT_WORDLIST_1_CARDINALITY
      ]!,
    );
  }
  return `wa-${words.join("-")}`;
}

export const WORKSPACE_APP_ROUTE_ID_ENTROPY_BITS =
  ROUTE_WORD_COUNT * Math.log2(EFF_SHORT_WORDLIST_1_CARDINALITY);
