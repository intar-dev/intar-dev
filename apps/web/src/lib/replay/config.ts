export const REPLAY_IDLE_TIME_LIMIT_SECONDS = 1.5;
export const REPLAY_TERMINAL_THEME = "intar";
export const REPLAY_TERMINAL_FONT_FAMILY =
  '"Recursive Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';
export const REPLAY_TERMINAL_FALLBACK_FONT_FAMILY =
  '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';
export const REPLAY_TERMINAL_FONT_LOAD = '400 14px "Recursive Mono"';

let replayTerminalFontLoad: Promise<boolean> | null = null;
let replayTerminalFontLoaded = false;

/** Starts one shared font request. Callers must not wait before opening SSH. */
export function loadReplayTerminalFont(): Promise<boolean> {
  if (replayTerminalFontLoaded) return Promise.resolve(true);
  if (replayTerminalFontLoad) return replayTerminalFontLoad;
  if (typeof document === "undefined" || !document.fonts) {
    return Promise.resolve(false);
  }

  const fonts = document.fonts;
  replayTerminalFontLoad = Promise.resolve()
    .then(async () => {
      if (fonts.check(REPLAY_TERMINAL_FONT_LOAD, "Mi0W ")) return true;
      const faces = await fonts.load(REPLAY_TERMINAL_FONT_LOAD, "Mi0W ");
      return faces.some((face) => face.status === "loaded");
    })
    .catch(() => false)
    .then((loaded) => {
      replayTerminalFontLoaded = loaded;
      return loaded;
    });
  return replayTerminalFontLoad;
}

export function isReplayTerminalFontLoaded() {
  return replayTerminalFontLoaded;
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
