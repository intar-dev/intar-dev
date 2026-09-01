export interface BashCompletionCandidates {
  staticCandidates: string[];
  hintCandidates: string[];
  solutionCandidates: string[];
}

export function bashCompletionProofScript(): string {
  return [
    "set -e",
    "declaration=$(complete -p intar)",
    'case "$declaration" in',
    '  *" -F "*) function_name=${declaration#* -F }; function_name=${function_name%% *} ;;',
    '  *) echo "intar completion must use a Bash function" >&2; exit 70 ;;',
    "esac",
    'case "$function_name" in',
    '  [a-zA-Z_][a-zA-Z0-9_]*) ;;',
    '  *) echo "intar completion function name is unsafe" >&2; exit 71 ;;',
    "esac",
    "COMP_WORDS=(intar hi)",
    "COMP_CWORD=1",
    "COMPREPLY=()",
    '"$function_name"',
    "printf '__INTAR_STATIC__%s\\n' \"${COMPREPLY[@]}\"",
    "COMP_WORDS=(intar hint '')",
    "COMP_CWORD=2",
    "COMPREPLY=()",
    '"$function_name"',
    "printf '__INTAR_HINT__%s\\n' \"${COMPREPLY[@]}\"",
    "COMP_WORDS=(intar solution re)",
    "COMP_CWORD=2",
    "COMPREPLY=()",
    '"$function_name"',
    "printf '__INTAR_SOLUTION__%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n");
}

export function parseBashCompletionCandidates(
  output: string,
): BashCompletionCandidates {
  const lines = output.split(/\r?\n/);
  return {
    staticCandidates: lines
      .filter((line) => line.startsWith("__INTAR_STATIC__"))
      .map((line) => line.slice("__INTAR_STATIC__".length)),
    hintCandidates: lines
      .filter((line) => line.startsWith("__INTAR_HINT__"))
      .map((line) => line.slice("__INTAR_HINT__".length)),
    solutionCandidates: lines
      .filter((line) => line.startsWith("__INTAR_SOLUTION__"))
      .map((line) => line.slice("__INTAR_SOLUTION__".length)),
  };
}

export function assertSafeHintCompletionAliases(aliases: string[]): void {
  if (
    aliases.some(
      (alias) => !/^[a-z0-9][a-z0-9-]*$/.test(alias) || alias.length > 128,
    )
  ) {
    throw new Error("Bash completion returned an unsafe hint alias");
  }
}
