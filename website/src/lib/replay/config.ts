export const REPLAY_IDLE_TIME_LIMIT_SECONDS = 1.5;
export const REPLAY_TERMINAL_THEME = "asciinema";
export const REPLAY_TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';

// One fixed grid shared by the live web terminal, kino recordings, and the
// per-session cast renderer (`compose_session` in
// crates/intar-agent/src/vm/replay_compose.rs must match).
// With the ~0.6em advance of the mono stack and this line height, a 4:1 grid
// renders exactly 16:9: 120 * 0.6em : 30 * 1.35em = 72 : 40.5 = 16 : 9.
export const REPLAY_TERMINAL_COLS = 120;
export const REPLAY_TERMINAL_ROWS = 30;
export const REPLAY_TERMINAL_LINE_HEIGHT = 1.35;
// Matches the asciinema-player "asciinema" theme colors.
export const REPLAY_TERMINAL_BACKGROUND = "#121314";
export const REPLAY_TERMINAL_FOREGROUND = "#cccccc";
