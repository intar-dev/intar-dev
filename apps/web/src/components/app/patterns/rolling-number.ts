export interface DigitCell {
  /** The character shown once the roll settles; empty when a place drops. */
  char: string;
  /** The character rolling out, or null when this place is unchanged. */
  previous: string | null;
  /** Stagger slot: ones roll first, then tens, so a carry reads leftward. */
  order: number;
}

/**
 * Lines up two renderings of a number right-aligned and marks the places that
 * changed. Unchanged places stay still; only changed ones roll.
 */
export function digitCells(from: string, to: string): DigitCell[] {
  const width = Math.max(from.length, to.length);
  const a = from.padStart(width, " ");
  const b = to.padStart(width, " ");
  const cells: DigitCell[] = [];
  let order = 0;
  for (let index = width - 1; index >= 0; index -= 1) {
    const before = a[index] ?? " ";
    const after = b[index] ?? " ";
    if (before === " " && after === " ") continue;
    if (before === after) {
      cells.unshift({ char: after, previous: null, order: 0 });
      continue;
    }
    cells.unshift({
      char: after === " " ? "" : after,
      previous: before === " " ? "" : before,
      order,
    });
    order += 1;
  }
  return cells;
}

/** Digits roll up as a number grows and down as it shrinks. */
export function rollDirection(from: number, to: number): 1 | -1 {
  return to < from ? -1 : 1;
}
