export const REPLAY_IDLE_TIME_LIMIT_SECONDS = 1.5;
export const REPLAY_TERMINAL_THEME = "intar";
export const REPLAY_TERMINAL_FONT_FAMILY =
  '"Geist Mono Variable", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';
export const REPLAY_TERMINAL_FALLBACK_FONT_FAMILY =
  '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';
export const REPLAY_TERMINAL_FONT_LOAD = '400 14px "Geist Mono Variable"';

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
export const REPLAY_TERMINAL_BACKGROUND = "#0f1114";
export const REPLAY_TERMINAL_FOREGROUND = "#dfe1e6";

// The live xterm canvas and replay player intentionally use this exact
// always-dark palette. The replay CSS maps these values to --term-color-0..15.
export const REPLAY_TERMINAL_XTERM_THEME = {
  background: REPLAY_TERMINAL_BACKGROUND,
  foreground: REPLAY_TERMINAL_FOREGROUND,
  cursor: "#f88a3d",
  cursorAccent: REPLAY_TERMINAL_BACKGROUND,
  selectionBackground: "#4a301f",
  black: "#2a2d33",
  red: "#f97772",
  green: "#62d397",
  yellow: "#efc469",
  blue: "#81bcf3",
  magenta: "#c9a2e8",
  cyan: "#72d0d0",
  white: "#dfe1e6",
  brightBlack: "#6b6f76",
  brightRed: "#ff9a94",
  brightGreen: "#86e3b1",
  brightYellow: "#f7d58c",
  brightBlue: "#a3cff7",
  brightMagenta: "#dbbdf1",
  brightCyan: "#97e0e0",
  brightWhite: "#f6f7f9",
} as const;
