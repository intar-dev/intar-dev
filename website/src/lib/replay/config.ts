export const REPLAY_IDLE_TIME_LIMIT_SECONDS = 1.5;
export const REPLAY_TERMINAL_THEME = "asciinema";
export const REPLAY_TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';
export const REPLAY_TERMINAL_FONT_SIZE_PX = 15;
export const REPLAY_TERMINAL_LINE_HEIGHT = 1.4;
export const REPLAY_TERMINAL_PADDING_PX = 12;

export const GIF_EXPORT_MAX_WIDTH_PX = 960;
export const GIF_EXPORT_TARGET_MAX_FRAMES = 1200;
export const GIF_EXPORT_MIN_FRAME_DELAY_MS = 50;
export const GIF_EXPORT_MAX_FRAME_DELAY_MS = 200;
export const GIF_EXPORT_FRAME_DELAY_QUANTUM_MS = 10;
export const GIF_EXPORT_MIN_PLAYABLE_DELAY_MS = 20;
export const GIF_EXPORT_FINAL_FRAME_DELAY_MS = 1000;

export interface ReplayThemePalette {
  foreground: string;
  background: string;
  colors: readonly string[];
}

export const ASCIINEMA_THEME_PALETTE: ReplayThemePalette = {
  foreground: "#cccccc",
  background: "#121314",
  colors: [
    "#000000",
    "#dd3c69",
    "#4ebf22",
    "#ddaf3c",
    "#26b0d7",
    "#b954e1",
    "#54e1b9",
    "#d9d9d9",
    "#4d4d4d",
    "#dd3c69",
    "#4ebf22",
    "#ddaf3c",
    "#26b0d7",
    "#b954e1",
    "#54e1b9",
    "#ffffff",
  ],
} as const;
