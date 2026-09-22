/** Combined allocation capacity for the user's accessible scenario host pools. */
export interface ResourceCapacity {
  cpu: { availableMillis: number; totalMillis: number };
  memory: { availableMib: number; totalMib: number };
}
