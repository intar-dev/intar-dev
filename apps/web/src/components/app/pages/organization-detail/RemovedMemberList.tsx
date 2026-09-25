import { RotateCcw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { OrganizationRemovedMemberRecord } from "@/lib/organizations";
import { formatRelativeTime } from "../../lib/format";
import { initials } from "./types";

/** People an organization's admins removed, each with Restore access. */
export function RemovedMemberList(props: {
  entries: OrganizationRemovedMemberRecord[];
  restoring: boolean;
  onRestore: (userId: string) => void;
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border">
      {props.entries.map((entry) => (
        <li
          key={entry.userId}
          className="flex flex-wrap items-center gap-3 px-4 py-3"
        >
          <Avatar>
            <AvatarFallback>{initials(entry.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{entry.name}</p>
            <p className="text-caption">
              {entry.email}
              {entry.githubUsername ? ` · @${entry.githubUsername}` : ""} ·
              removed {formatRelativeTime(entry.removedAt)}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={props.restoring}
            onClick={() => props.onRestore(entry.userId)}
          >
            <RotateCcw className="size-3.5" />
            Restore access
          </Button>
        </li>
      ))}
    </ul>
  );
}
