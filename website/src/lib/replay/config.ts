export const REPLAY_IDLE_TIME_LIMIT_SECONDS = 1.5;
export const REPLAY_TERMINAL_THEME = "asciinema";
export const REPLAY_TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';

// Pre-fit constructor defaults for the live web terminal. The live grid
// reflows to its container (fit addon + PTY resize frames); recordings keep
// their recorded geometry and the player renders the original aspect ratio.
export const REPLAY_TERMINAL_COLS = 120;
export const REPLAY_TERMINAL_ROWS = 30;
export const REPLAY_TERMINAL_LINE_HEIGHT = 1.35;
// Matches the asciinema-player "asciinema" theme colors.
export const REPLAY_TERMINAL_BACKGROUND = "#121314";
export const REPLAY_TERMINAL_FOREGROUND = "#cccccc";
