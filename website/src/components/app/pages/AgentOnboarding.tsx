import { PageShell } from "@/components/app/patterns/PageShell";
import { HostOnboardingPanel } from "@/components/app/HostOnboardingPanel";

export function AgentOnboarding() {
  return (
    <PageShell
      admin
      title="Host onboarding"
      description="Generate a bridge config to register a new agent or builder host."
    >
      <HostOnboardingPanel eyebrow="New host" title="Bridge config" />
    </PageShell>
  );
}
