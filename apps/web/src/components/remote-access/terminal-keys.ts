export type ArrowKey = "up" | "down" | "right" | "left";

const ARROW_LETTER: Record<ArrowKey, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/** Arrows follow the application cursor mode the shell asked for (vim, less). */
export function arrowSequence(key: ArrowKey, applicationMode: boolean): string {
  return `${applicationMode ? "\x1bO" : "\x1b["}${ARROW_LETTER[key]}`;
}

/** Ctrl turns one key into its control code: c becomes ETX, [ becomes ESC. */
export function applyCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.charCodeAt(0);
  if (code >= 0x40 && code <= 0x7f) return String.fromCharCode(code & 0x1f);
  return data;
}

/**
 * Ctrl on the key row: a tap latches it for one key, a second tap in quick
 * succession locks it, and a tap while latched (slowly) or locked releases it.
 */
export type CtrlState = "off" | "latched" | "locked";

export const CTRL_DOUBLE_TAP_MS = 350;

export function nextCtrlState(
  state: CtrlState,
  sinceLastTapMs: number,
): CtrlState {
  if (state === "off") return "latched";
  if (state === "latched" && sinceLastTapMs <= CTRL_DOUBLE_TAP_MS) return "locked";
  return "off";
}
