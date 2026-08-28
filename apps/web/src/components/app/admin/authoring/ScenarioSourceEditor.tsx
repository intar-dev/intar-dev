import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export interface ScenarioSourceEditorProps
  extends Omit<
    ComponentPropsWithoutRef<"textarea">,
    "className" | "defaultValue" | "onChange" | "value"
  > {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function ScenarioSourceEditor({
  value,
  onChange,
  className,
  name = "scenario-hcl",
  ...textareaProps
}: ScenarioSourceEditorProps) {

  return (
    <div className="terminal-surface overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b border-terminal-border bg-terminal-surface px-3 py-2 text-caption text-terminal-muted">
        <span className="font-mono">scenario.hcl</span>
        <span>Browser find · native undo</span>
      </div>
      <textarea
        {...textareaProps}
        name={name}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={textareaProps["aria-label"] ?? "Scenario HCL source"}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        wrap="off"
        rows={24}
        className={cn(
          "block min-h-[24rem] max-h-[42rem] w-full resize-y overflow-auto border-0 bg-terminal-background px-3 py-3 text-code text-terminal-foreground outline-none selection:bg-terminal-brand/25 placeholder:text-terminal-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
      />
    </div>
  );
}
