// Small stat tiles used across the hosts console.

export function DetailStat(props: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/15 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">{props.value}</p>
      {props.detail ? (
        <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
      ) : null}
    </div>
  );
}

export function WorkspaceStat(props: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 px-5 py-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight">
        {props.value}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

export function HostMetric(props: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/15 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">{props.value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
    </div>
  );
}
