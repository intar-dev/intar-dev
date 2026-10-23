import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Hammer, Server } from "lucide-react";
import { apiErrorMessage } from "@/components/app/lib/api-errors";
import { formatTimestamp } from "@/components/app/lib/format";
import { HttpResponseError } from "@/components/app/lib/http-response-error";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { CodeBlock } from "@/components/app/patterns/CodeBlock";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type HostRole = "agent" | "builder";

interface PlatformEnrollment {
  hostId: string;
  enrollmentToken: string;
  expiresAt: number;
  role: HostRole;
}

interface HostOnboardingPanelProps {
  eyebrow?: string;
  title?: string;
}

// The script asks for the token on the host's terminal, so neither the
// command nor shell history holds a secret. The credential file is created
// before the claim so a failed write cannot strand a claimed host.
export function claimScript(origin: string, role: HostRole): string {
  const write =
    role === "agent"
      ? `path = '/etc/intar-agent/credential.json'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
os.fchown(fd, 0, grp.getgrnam('intar-agent').gr_gid)
try:
    claim = enroll()
    with os.fdopen(fd, 'w') as file:
        json.dump({**claim, 'credential': credential}, file)
except BaseException:
    os.unlink(path)
    raise
print('Wrote ' + path + '. Restart intar-agent.')`
      : `claim = enroll()
print('Add to [bridge] in /etc/intar-builder/config.toml, then restart intar-builder:')
print('host_id = "' + claim['hostId'] + '"')
print('bootstrap_token = "' + credential + '"')`;
  return `sudo python3 -I - <<'PY'
import getpass, grp, json, os, secrets, urllib.request
token = getpass.getpass('Enrollment token: ').strip()
credential = secrets.token_hex(32)
def enroll():
    request = urllib.request.Request('${origin}/agent/enroll', method='POST',
        data=json.dumps({'enrollmentToken': token, 'credential': credential}).encode(),
        headers={'Content-Type': 'application/json', 'User-Agent': 'intar-host'})
    with urllib.request.urlopen(request, timeout=30) as response:
        claim = json.load(response)
    return {key: claim[key] for key in ('hostId', 'ownerUserId', 'scope', 'credentialGeneration')}
${write}
PY`;
}

export function HostOnboardingPanel({
  eyebrow = "Host onboarding",
  title = "Host enrollment",
}: HostOnboardingPanelProps) {
  const [hostName, setHostName] = useState("");
  const [hostRole, setHostRole] = useState<HostRole>("agent");
  const [enrollment, setEnrollment] = useState<PlatformEnrollment | null>(
    null,
  );
  const [revealed, setRevealed] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const onboard = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/servers/enrollments", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: hostName.trim(),
          scope: "platform",
          role: hostRole,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw HttpResponseError.fromBody(
          response.status,
          body,
          "Enrollment failed. Try again.",
        );
      }
      const result = (await response.json()) as Omit<
        PlatformEnrollment,
        "role"
      >;
      return { ...result, role: hostRole };
    },
    onSuccess: (result) => {
      setEnrollment(result);
      setRevealed(false);
      setCopyFeedback(null);
    },
  });

  const copyToken = async () => {
    if (!enrollment) return;
    if (enrollment.expiresAt <= Date.now()) {
      setEnrollment(null);
      setCopyFeedback("Token expired. Create a new token to continue.");
      return;
    }
    try {
      await navigator.clipboard.writeText(enrollment.enrollmentToken);
      setCopyFeedback("Token copied.");
    } catch {
      setCopyFeedback("Token could not be copied.");
    }
  };

  const pending = onboard.isPending;

  return (
    <section className="grid gap-4 @min-[64rem]/panel:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
      <div className="space-y-4 rounded-xl border bg-card p-4 shadow-[var(--highlight),var(--shadow-raised)]">
        <div className="space-y-1">
          <p className="text-label">{eyebrow}</p>
          <h2 className="text-section-title">{title}</h2>
        </div>

        <div
          role="group"
          aria-label="Host role"
          className="grid gap-2 sm:grid-cols-2"
        >
          <Button
            type="button"
            aria-pressed={hostRole === "agent"}
            variant={hostRole === "agent" ? "default" : "outline"}
            onClick={() => setHostRole("agent")}
            disabled={pending}
            className="justify-start"
          >
            <Server className="size-4" />
            Agent
          </Button>
          <Button
            type="button"
            aria-pressed={hostRole === "builder"}
            variant={hostRole === "builder" ? "default" : "outline"}
            onClick={() => setHostRole("builder")}
            disabled={pending}
            className="justify-start"
          >
            <Hammer className="size-4" />
            Builder
          </Button>
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          aria-busy={pending || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && hostName.trim()) onboard.mutate();
          }}
        >
          <label htmlFor="host-onboarding-name" className="sr-only">
            Host name
          </label>
          {/* readOnly, not disabled: focus stays in the field and the touch
              height holds while the request runs. */}
          <Input
            mono
            id="host-onboarding-name"
            name="hostName"
            placeholder="Host name"
            autoComplete="off"
            required
            maxLength={80}
            value={hostName}
            onChange={(event) => setHostName(event.currentTarget.value)}
            readOnly={pending}
            className="flex-1 sm:max-w-field"
          />
          <Button
            type="submit"
            aria-busy={pending || undefined}
            focusableWhenDisabled
            disabled={pending || !hostName.trim()}
          >
            <AsyncLabel
              state={pending ? "pending" : "idle"}
              idle="Create token"
              pending="Creating token…"
            />
          </Button>
        </form>

        {onboard.error ? (
          <Alert variant="destructive" just>
            <AlertTitle>Enrollment failed</AlertTitle>
            <AlertDescription>
              {apiErrorMessage(onboard.error, "Enrollment failed. Try again.")}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-[var(--highlight),var(--shadow-raised)]">
        {enrollment ? (
          <div className="space-y-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-label">Host ID</dt>
                <dd className="mt-1 font-mono text-xs break-all">
                  {enrollment.hostId}
                </dd>
              </div>
              <div>
                <dt className="text-label">Role</dt>
                <dd className="mt-1 font-medium capitalize">
                  {enrollment.role}
                </dd>
              </div>
              <div>
                <dt className="text-label">Token expires</dt>
                <dd className="mt-1 font-medium">
                  {formatTimestamp(enrollment.expiresAt)}
                </dd>
              </div>
            </dl>

            <div className="space-y-2">
              <p className="text-sm font-medium">Run on the host as root</p>
              <CodeBlock language="bash" copyName="Copy enrollment script">
                <code>
                  {claimScript(window.location.origin, enrollment.role)}
                </code>
              </CodeBlock>
            </div>

            <div className="space-y-2" data-private>
              <p className="text-sm font-medium">Enrollment token</p>
              <p className="text-sm text-muted-foreground">
                Single use. Paste it when the script asks. This page does not
                save the token.
              </p>
              <p
                className="rounded-lg bg-muted/50 p-3 font-mono text-xs break-all"
                aria-label={
                  revealed ? "Enrollment token" : "Enrollment token hidden"
                }
              >
                {revealed ? enrollment.enrollmentToken : "••••••••••••••••"}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  aria-pressed={revealed}
                  onClick={() => setRevealed(!revealed)}
                >
                  {revealed ? "Hide token" : "Reveal token"}
                </Button>
                <Button variant="outline" onClick={() => void copyToken()}>
                  Copy token
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-48 items-center justify-center rounded-xl bg-muted/40 px-4 text-center text-sm text-muted-foreground">
            Create a token to reveal the enrollment script for the host.
          </div>
        )}
        {copyFeedback ? (
          <InlineFeedback
            tone={copyFeedback === "Token copied." ? "success" : "error"}
          >
            {copyFeedback}
          </InlineFeedback>
        ) : null}
      </div>
    </section>
  );
}
