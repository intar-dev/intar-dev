import { AdminWorkspaceNav } from "@/components/app/AdminWorkspaceNav";
import { AuthenticatedShell } from "@/components/app/AuthenticatedShell";
import { HostOnboardingPanel } from "@/components/app/HostOnboardingPanel";

export function AgentOnboarding() {
  return (
    <AuthenticatedShell
      title="Agent onboarding"
      description="Generate a bridge config for a host."
    >
      <AdminWorkspaceNav />
      <HostOnboardingPanel eyebrow="New host" title="Bridge config" />
    </AuthenticatedShell>
  );
}
