/** Allocation capacity for the user's selected scenario host pool. */
export interface ResourceCapacity {
  cpu: { availableMillis: number; totalMillis: number };
  memory: { availableMib: number; totalMib: number };
}
