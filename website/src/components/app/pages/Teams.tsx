import { Users } from "lucide-react";
import { PageHeader } from "../patterns/PageHeader";
import { EmptyState } from "../patterns/StateCard";

// Placeholder Teams surface. Phase 3 activates the orgs layer: create a team,
// invite members, assign scenarios, and an instructor progress grid.
export function Teams() {
  return (
    <>
      <PageHeader
        eyebrow="Teams"
        title="Teams"
        description="Run cohorts: invite members, assign scenarios, and track progress."
      />
      <EmptyState
        icon={<Users className="size-6" />}
        title="Teams are on the way"
        description="Soon you'll be able to create a team, invite members by GitHub username, assign scenarios, and watch each member's progress."
      />
    </>
  );
}
