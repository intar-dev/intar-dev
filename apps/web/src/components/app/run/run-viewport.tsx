import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";

/**
 * The run workspace answers to three named thresholds (viewports.md): the
 * panel docks under the terminal from 48rem (bp-md), sits beside it from 60rem
 * (bp-run), and anything shorter than 31.25rem (bp-short) is a phone on its
 * side. They are defined once here and in global.css (`dock:`, `split:`,
 * `short:`, `phone:`), so a media query never drifts from a class.
 */
export const RUN_QUERY = {
  /** Terminal over a docked panel. */
  docked: "(min-width: 48rem) and (min-height: 31.25rem)",
  /** Terminal beside the panel. */
  split: "(min-width: 60rem) and (min-height: 31.25rem)",
  /** Landscape phone: slim bar, side sheet. */
  short: "(max-height: 31.25rem)",
  /** Terminal type steps from 13px to 14px here. */
  terminalType: "(min-width: 48rem)",
  coarse: "(pointer: coarse)",
} as const;

/** The on-screen keyboard has to take at least this much of the height. */
const KEYBOARD_MIN_GAP_PX = 120;

export function useMediaQuery(query: string, initial = false): boolean {
  // The page is client-only, so the first render can already read the query
  // and a tablet never flashes the phone layout.
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : initial,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

interface RunFrameState {
  /** The on-screen keyboard is up and the terminal holds focus. */
  keyboardUp: boolean;
}

const RunFrameContext = createContext<RunFrameState>({ keyboardUp: false });

export const RunFrameProvider = RunFrameContext.Provider;

export function useRunFrame(): RunFrameState {
  return useContext(RunFrameContext);
}

/**
 * Sizes the run frame from `visualViewport.height` (Safari ignores
 * interactive-widget=resizes-content) through --run-vh, and reports whether
 * the on-screen keyboard is up. A hardware keyboard never shrinks the visual
 * viewport, so it does not count. The terminal's own ResizeObserver refits
 * when the frame height changes.
 */
export function useRunKeyboard(frameRef: RefObject<HTMLElement | null>): boolean {
  const [keyboardUp, setKeyboardUp] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    const viewport = window.visualViewport;
    if (!frame || !viewport || typeof window.matchMedia !== "function") return;
    const coarse = window.matchMedia(RUN_QUERY.coarse);
    // Chrome shrinks the layout viewport with the keyboard too, so the gap is
    // measured against the tallest visual viewport seen at this width.
    let baseline = { width: window.innerWidth, height: viewport.height };

    const update = () => {
      if (!coarse.matches) {
        frame.style.removeProperty("--run-vh");
        setKeyboardUp(false);
        return;
      }
      // A pinch zoom shrinks the visual viewport too; that is not a keyboard.
      if (viewport.scale > 1.01) {
        frame.style.removeProperty("--run-vh");
        setKeyboardUp(false);
        return;
      }
      if (window.innerWidth !== baseline.width) {
        baseline = { width: window.innerWidth, height: viewport.height };
      }
      baseline.height = Math.max(baseline.height, viewport.height);
      frame.style.setProperty("--run-vh", `${viewport.height}px`);
      // iOS pans the layout viewport toward the caret; the frame already fits
      // the visual one, so put the page back.
      if (viewport.offsetTop > 0) window.scrollTo(0, 0);
      const inTerminal = Boolean(
        document.activeElement?.closest?.("[data-run-terminal]"),
      );
      setKeyboardUp(
        inTerminal && baseline.height - viewport.height > KEYBOARD_MIN_GAP_PX,
      );
    };
    // focusout reports the old element while focus moves, so read it a tick
    // later.
    const updateAfterFocus = () => window.setTimeout(update, 0);

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    coarse.addEventListener("change", update);
    document.addEventListener("focusin", updateAfterFocus);
    document.addEventListener("focusout", updateAfterFocus);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      coarse.removeEventListener("change", update);
      document.removeEventListener("focusin", updateAfterFocus);
      document.removeEventListener("focusout", updateAfterFocus);
      frame.style.removeProperty("--run-vh");
    };
  }, [frameRef]);

  return keyboardUp;
}

export type RunSheetSection = "checks" | "lecture" | "hints";
export type RunSheetDetent = "peek" | "full";

/** Peek shows the checks; lecture and hints need the room. */
export function detentForSection(section: RunSheetSection): RunSheetDetent {
  return section === "checks" ? "peek" : "full";
}

export interface RunSheetController {
  open: boolean;
  section: RunSheetSection;
  detent: RunSheetDetent;
  /** The control that opened the sheet, so closing can return focus to it. */
  openerRef: MutableRefObject<HTMLElement | null>;
  openSheet: (
    section: RunSheetSection,
    options?: { detent?: RunSheetDetent; opener?: HTMLElement | null },
  ) => void;
  closeSheet: () => void;
  setDetent: (detent: RunSheetDetent) => void;
}

const RunSheetContext = createContext<RunSheetController | null>(null);

export const RunSheetProvider = RunSheetContext.Provider;

/** The shell's lifted sheet state, or null for a panel used on its own. */
export function useRunSheet(): RunSheetController | null {
  return useContext(RunSheetContext);
}

/**
 * One sheet for the whole run page: the dock, the landscape bar buttons and
 * the completion beat all open the same panel. Reading and typing take turns,
 * so opening the sheet lowers the keyboard.
 */
export function useRunSheetController(): RunSheetController {
  const [state, setState] = useState<{
    open: boolean;
    section: RunSheetSection;
    detent: RunSheetDetent;
  }>({ open: false, section: "checks", detent: "peek" });
  const openerRef = useRef<HTMLElement | null>(null);

  const openSheet = useCallback<RunSheetController["openSheet"]>(
    (section, options) => {
      if (options?.opener !== undefined) openerRef.current = options.opener;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[data-run-terminal]")) {
        active.blur();
      }
      setState({
        open: true,
        section,
        detent: options?.detent ?? detentForSection(section),
      });
    },
    [],
  );
  const closeSheet = useCallback(
    () => setState((current) => (current.open ? { ...current, open: false } : current)),
    [],
  );
  const setDetent = useCallback(
    (detent: RunSheetDetent) =>
      setState((current) => (current.detent === detent ? current : { ...current, detent })),
    [],
  );

  return useMemo(
    () => ({ ...state, openerRef, openSheet, closeSheet, setDetent }),
    [state, openSheet, closeSheet, setDetent],
  );
}
