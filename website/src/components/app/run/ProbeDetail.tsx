import { parseProbeValue } from "@/lib/probe-values";
import { cn } from "@/lib/utils";

// Renders the structured "why is this probe failing/passing" detail for a probe
// value. Returns null when there's nothing to show (no value yet, unknown kind).
export function ProbeDetail({
  kind,
  value,
  className,
}: {
  kind: string;
  value: unknown;
  className?: string;
}) {
  const parsed = parseProbeValue(kind, value);
  if (!parsed) return null;

  return (
    <div className={cn("space-y-2 text-xs", className)}>
      {renderDetail(parsed)}
    </div>
  );
}

function Mono({ children }: { children: string }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function State({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "font-medium",
        ok ? "text-success" : "text-destructive",
      )}
    >
      {children}
    </span>
  );
}

function renderDetail(parsed: NonNullable<ReturnType<typeof parseProbeValue>>) {
  switch (parsed.kind) {
    case "file_exists": {
      const v = parsed.value;
      return (
        <Row label="File">
          <code>{v.path}</code> — <State ok={v.exists}>{v.exists ? "present" : "missing"}</State>
        </Row>
      );
    }
    case "file_regex_capture": {
      const v = parsed.value;
      return (
        <>
          <Row label="File"><code>{v.path}</code></Row>
          <Row label="Pattern"><code>{v.pattern}</code></Row>
          <Row label="Match"><State ok={v.matched}>{v.matched ? "matched" : "no match"}</State></Row>
          {v.captures.length ? (
            <Row label="Captures">{v.captures.join(", ")}</Row>
          ) : null}
          {!v.matched && v.fileContent ? <Mono>{v.fileContent}</Mono> : null}
        </>
      );
    }
    case "port_open": {
      const v = parsed.value;
      return (
        <>
          <Row label="Target">
            <code>{v.host}:{v.port}/{v.protocol}</code> — <State ok={v.open}>{v.open ? "open" : "closed"}</State>
          </Row>
          {v.detail ? <Row label="Detail">{v.detail}</Row> : null}
        </>
      );
    }
    case "service": {
      const v = parsed.value;
      return (
        <>
          <Row label="Service"><code>{v.service}</code></Row>
          <Row label="Want"><code>{v.desiredState}</code></Row>
          <Row label="Actual">
            <State ok={v.stateSatisfied}>{v.actualState ?? "unknown"}</State>
          </Row>
        </>
      );
    }
    case "k8s_pod_state": {
      const v = parsed.value;
      return (
        <>
          <Row label="Namespace"><code>{v.namespace}</code></Row>
          <Row label="Selector"><code>{v.selector}</code></Row>
          <Row label="Want"><code>{v.desiredState}</code></Row>
          <Row label="Matched">
            <State ok={v.stateSatisfied}>{v.matchedPods} pod(s)</State>
          </Row>
          {v.matchingPodNames.length ? (
            <div className="flex flex-wrap gap-1">
              {v.matchingPodNames.map((name) => (
                <code
                  key={name}
                  className="rounded bg-muted/60 px-1.5 py-0.5 text-[0.7rem]"
                >
                  {name}
                </code>
              ))}
            </div>
          ) : null}
        </>
      );
    }
    case "command_json_path": {
      const v = parsed.value;
      return (
        <>
          <Row label="Command"><code>{v.argv.join(" ")}</code></Row>
          <Row label="JSONPath"><code>{v.jsonPath}</code></Row>
          {v.expectedJson ? <Row label="Expected"><code>{v.expectedJson}</code></Row> : null}
          <Row label="Result">
            <State ok={v.matched}>{v.matched ? "matched" : "no match"}</State>
            <span className="ml-2 text-muted-foreground">exit {v.exitCode}</span>
          </Row>
          {v.matchedValues.length ? (
            <Row label="Values">{v.matchedValues.join(", ")}</Row>
          ) : null}
          {v.stdout ? <Mono>{v.stdout}</Mono> : null}
          {v.stderr ? <Mono>{v.stderr}</Mono> : null}
        </>
      );
    }
    default:
      return null;
  }
}
