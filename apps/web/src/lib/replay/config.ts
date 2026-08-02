export const REPLAY_IDLE_TIME_LIMIT_SECONDS = 1.5;
export const REPLAY_TERMINAL_THEME = "intar";
export const REPLAY_TERMINAL_FONT_FAMILY =
  '"Recursive Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';
export const REPLAY_TERMINAL_FONT_LOAD = '400 14px "Recursive Mono"';

export async function loadReplayTerminalFont(timeoutMs = 3_000) {
  if (typeof document === "undefined" || !document.fonts) return false;

  const deadline = performance.now() + timeoutMs;
  do {
    const faces = await document.fonts.load(
      REPLAY_TERMINAL_FONT_LOAD,
      "Mi0W ",
    );
    if (faces.some((face) => face.status === "loaded")) return true;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  } while (performance.now() < deadline);

  return false;
}

// Pre-fit constructor defaults for the live web terminal. The live grid
// reflows to its container (fit addon + PTY resize frames); recordings keep
// their recorded geometry and the player renders the original aspect ratio.
export const REPLAY_TERMINAL_COLS = 120;
export const REPLAY_TERMINAL_ROWS = 30;
export const REPLAY_TERMINAL_LINE_HEIGHT = 1.35;
// Shared by the live xterm canvas and the custom replay theme.
export const REPLAY_TERMINAL_BACKGROUND = "#151716";
export const REPLAY_TERMINAL_FOREGROUND = "#f1ede5";

// The live xterm canvas and replay player intentionally use this exact
// always-dark palette. The replay CSS maps these values to --term-color-0..15.
export const REPLAY_TERMINAL_XTERM_THEME = {
  background: REPLAY_TERMINAL_BACKGROUND,
  foreground: REPLAY_TERMINAL_FOREGROUND,
  cursor: "#ef7b45",
  cursorAccent: REPLAY_TERMINAL_BACKGROUND,
  selectionBackground: "#4a3328",
  black: "#252927",
  red: "#ef7f76",
  green: "#76c895",
  yellow: "#e2b960",
  blue: "#75a9d6",
  magenta: "#c895c9",
  cyan: "#7dc7c7",
  white: "#e6e1d8",
  brightBlack: "#69736d",
  brightRed: "#ff9b93",
  brightGreen: "#91dda9",
  brightYellow: "#f2cc77",
  brightBlue: "#91bce0",
  brightMagenta: "#d8add8",
  brightCyan: "#9bdddd",
  brightWhite: "#fffaf0",
} as const;
