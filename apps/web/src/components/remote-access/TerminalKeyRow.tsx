import { useRef, type PointerEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Keyboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEdgeFade } from "@/components/app/run/use-edge-fade";
import {
  nextCtrlState,
  type ArrowKey,
  type CtrlState,
} from "./terminal-keys";

const KEY_CLASS =
  "inline-grid min-w-(--key-width) shrink-0 place-items-center rounded-md border border-terminal-border bg-terminal-background px-2.5 text-[0.8125rem] font-medium text-terminal-foreground transition-[background-color,transform] duration-(--duration-instant) ease-standard select-none active:translate-y-(--move-press) active:scale-(--scale-press) active:bg-terminal-surface [-webkit-tap-highlight-color:transparent] touch-manipulation h-(--key-height) short:h-9";

/**
 * The keys a phone keyboard lacks, riding on top of it. Every key sends
 * through the terminal's own input path, and pressing one never takes focus
 * from the terminal, so the keyboard stays up.
 */
export function TerminalKeyRow({
  ctrl,
  onCtrlChange,
  onKey,
  onArrow,
  onPaste,
  onHide,
}: {
  ctrl: CtrlState;
  onCtrlChange: (state: CtrlState) => void;
  /** A literal key or control sequence. */
  onKey: (sequence: string) => void;
  onArrow: (key: ArrowKey) => void;
  onPaste: () => void;
  onHide: () => void;
}) {
  const lastCtrlTap = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  useEdgeFade(scroller);

  const keepFocus = (event: PointerEvent<HTMLElement>) => event.preventDefault();
  const key = (
    label: ReactNode,
    action: () => void,
    options: { name?: string; mono?: boolean } = {},
  ) => (
    <button
      type="button"
      aria-label={options.name}
      className={cn(KEY_CLASS, options.mono && "font-mono text-[0.9375rem]")}
      onPointerDown={keepFocus}
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
    >
      {label}
    </button>
  );
  const arrow = (direction: ArrowKey, icon: ReactNode, name: string) =>
    key(icon, () => onArrow(direction), { name });

  return (
    <div
      role="group"
      aria-label="Terminal keys"
      data-terminal-key-row
      className="terminal-surface scroll-fade no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-t px-1.5 py-1.25"
      ref={scroller}
    >
      {key("Esc", () => onKey("\x1b"))}
      {key("Tab", () => onKey("\t"))}
      <button
        type="button"
        aria-pressed={ctrl !== "off"}
        data-lock={ctrl === "locked" ? "" : undefined}
        className={cn(
          KEY_CLASS,
          ctrl !== "off" &&
            "border-terminal-brand bg-[color-mix(in_oklab,var(--terminal-brand)_22%,var(--terminal-background))]",
          ctrl === "locked" && "shadow-[inset_0_-2px_0_var(--terminal-brand)]",
        )}
        onPointerDown={keepFocus}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const now = Date.now();
          onCtrlChange(nextCtrlState(ctrl, now - lastCtrlTap.current));
          lastCtrlTap.current = now;
        }}
      >
        Ctrl
        <span className="sr-only">
          {ctrl === "locked" ? ", locked" : ctrl === "latched" ? ", on for one key" : ""}
        </span>
      </button>
      {arrow("up", <ArrowUp className="size-4" aria-hidden="true" />, "Up")}
      {arrow("down", <ArrowDown className="size-4" aria-hidden="true" />, "Down")}
      {arrow("left", <ArrowLeft className="size-4" aria-hidden="true" />, "Left")}
      {arrow("right", <ArrowRight className="size-4" aria-hidden="true" />, "Right")}
      {key("|", () => onKey("|"), { name: "Pipe", mono: true })}
      {key("-", () => onKey("-"), { name: "Hyphen", mono: true })}
      {key("/", () => onKey("/"), { name: "Slash", mono: true })}
      {key("~", () => onKey("~"), { name: "Tilde", mono: true })}
      {key(
        <span className="inline-flex items-center gap-1.5">
          <ClipboardPaste className="size-4" aria-hidden="true" />
          Paste
        </span>,
        onPaste,
      )}
      {key(<Keyboard className="size-4" aria-hidden="true" />, onHide, {
        name: "Hide keyboard",
      })}
    </div>
  );
}
