export const DESKTOP_RUN_RAIL_MIN_WIDTH = 1_120;

export function shouldShowDesktopRunRail(width: number) {
  return width >= DESKTOP_RUN_RAIL_MIN_WIDTH;
}
