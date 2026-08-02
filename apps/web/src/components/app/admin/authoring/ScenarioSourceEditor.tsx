import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";

const editorTheme = EditorView.theme({
  "&": {
    minHeight: "24rem",
    background: "var(--terminal-background)",
    color: "var(--terminal-foreground)",
    fontSize: "0.8125rem",
  },
  "&.cm-focused": {
    outline: "2px solid var(--ring)",
    outlineOffset: "-2px",
  },
  ".cm-scroller": {
    minHeight: "24rem",
    fontFamily: '"Recursive Mono", "SFMono-Regular", ui-monospace, monospace',
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "0.75rem 0 2rem" },
  ".cm-line": { padding: "0 1rem" },
  ".cm-cursor": { borderLeftColor: "var(--terminal-brand)" },
  ".cm-gutters": {
    background: "var(--terminal-surface)",
    color: "var(--terminal-muted)",
    borderRight: "1px solid var(--terminal-border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    background: "color-mix(in oklch, var(--terminal-brand) 9%, transparent)",
  },
  ".cm-selectionBackground, ::selection": {
    background: "color-mix(in oklch, var(--terminal-brand) 24%, transparent)",
  },
  ".cm-panels": {
    background: "var(--terminal-surface)",
    color: "var(--terminal-foreground)",
    borderBottom: "1px solid var(--terminal-border)",
  },
  ".cm-textfield": {
    background: "var(--terminal-background)",
    color: "var(--terminal-foreground)",
    border: "1px solid var(--terminal-border)",
    borderRadius: "0.375rem",
  },
  ".cm-button": {
    background: "var(--terminal-surface)",
    color: "var(--terminal-foreground)",
    border: "1px solid var(--terminal-border)",
    borderRadius: "0.375rem",
  },
}, { dark: true });

const editorKeymap = [
  ...defaultKeymap,
  ...historyKeymap,
  ...searchKeymap,
] as unknown as readonly KeyBinding[];

export function ScenarioSourceEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;

    editorRef.current = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          search({ top: true }),
          keymap.of(editorKeymap),
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({
            "aria-label": "Scenario HCL source",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          editorTheme,
        ],
      }),
    });

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div className="terminal-surface overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b border-terminal-border bg-terminal-surface px-3 py-2 text-xs text-terminal-muted">
        <span className="font-mono">scenario.hcl</span>
        <span>⌘F search · ⌘Z history</span>
      </div>
      <div ref={containerRef} className="max-h-[42rem] overflow-auto" />
    </div>
  );
}
