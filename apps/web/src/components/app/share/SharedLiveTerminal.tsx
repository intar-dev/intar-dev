import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import {
  REPLAY_TERMINAL_FALLBACK_FONT_FAMILY,
  REPLAY_TERMINAL_FONT_FAMILY,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_XTERM_THEME,
  isReplayTerminalFontLoaded,
  loadReplayTerminalFont,
} from "@/lib/replay/config";
import { SHARE_VIEWER_FONT_SIZE_PX } from "@/lib/run-share/protocol";
import {
  createShareEventPump,
  type ShareEventPump,
} from "@/lib/run-share/shared-run-pump";
import type { ShareSession } from "@/lib/run-share/shared-run-model";

/**
 * One session's terminal as a viewer sees it: the learner's screen, read-only,
 * at 16pt so it still reads when the page is captured for a livestream. It has
 * the session's own grid and no fit, so a terminal wider than the page scrolls
 * sideways inside its frame instead of shrinking the text.
 *
 * It draws the session's log from the start when it mounts, then whatever the
 * log gains. `pausedAt` holds the screen at that many events while the log
 * keeps growing; lifting it writes the backlog.
 */
export function SharedLiveTerminal({
  session,
  pausedAt,
  label,
}: {
  session: Pick<ShareSession, "id" | "mode" | "cols" | "rows" | "events">;
  /** The number of events the screen is held at, or null while it follows. */
  pausedAt: number | null;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pumpRef = useRef<ShareEventPump | null>(null);

  // What the log holds now: read by the effect that makes the terminal, which
  // has to start from it, and by the one that follows the log as it grows.
  const until = pausedAt ?? undefined;
  const latest = useRef({ events: session.events, until });
  latest.current = { events: session.events, until };

  // The terminal is made once per session: its grid and its line endings are
  // the session's, and a resize arrives as an event in the log.
  const { id, mode, cols, rows } = session;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cols,
      rows,
      // The learner's web terminal draws with convertEol; their own terminal
      // behind a native SSH login does not.
      convertEol: mode === "browser",
      // Nothing typed here goes anywhere, and the terminal's own answers to
      // the program (cursor reports and the like) must not either.
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "block",
      fontFamily: isReplayTerminalFontLoaded()
        ? REPLAY_TERMINAL_FONT_FAMILY
        : REPLAY_TERMINAL_FALLBACK_FONT_FAMILY,
      fontSize: SHARE_VIEWER_FONT_SIZE_PX,
      lineHeight: REPLAY_TERMINAL_LINE_HEIGHT,
      theme: REPLAY_TERMINAL_XTERM_THEME,
      // A program can write links into its output (OSC 8); they are drawn but
      // never followed, and never ask the viewer to confirm anything.
      linkHandler: { activate: () => undefined },
    });
    terminal.open(container);
    // The frame around it is the one keyboard stop, so arrow keys scroll it;
    // the terminal's own input is off and has no use for focus.
    terminal.textarea?.setAttribute("tabindex", "-1");

    let current = true;
    void loadReplayTerminalFont().then((loaded) => {
      if (loaded && current) {
        terminal.options.fontFamily = REPLAY_TERMINAL_FONT_FAMILY;
      }
    });

    const pump = createShareEventPump(terminal);
    pumpRef.current = pump;
    pump.push(latest.current.events, latest.current.until);

    return () => {
      current = false;
      pumpRef.current = null;
      pump.dispose();
      terminal.dispose();
    };
  }, [id, mode, cols, rows]);

  useEffect(() => {
    pumpRef.current?.push(session.events, until);
  }, [session.events, until]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      data-share-terminal
      className="overflow-x-auto py-2 pr-2 pl-3 focus-visible:outline-offset-[-2px]"
    />
  );
}
