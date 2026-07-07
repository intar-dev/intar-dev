import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Hammer,
  LayoutDashboard,
  Library,
  ListChecks,
  Server,
  User,
  Users,
} from "lucide-react";

export type NavRequirement = "signedIn" | "admin";

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  requires: NavRequirement;
  /** Match the active state on this prefix (defaults to `to`). */
  matchPrefix?: string;
}

export interface NavSection {
  id: string;
  label: string;
  requires: NavRequirement;
  items: NavItem[];
}

// Single source of truth for the sidebar and breadcrumb labels. Role filtering
// happens at render time via `isAdminUser`.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "learn",
    label: "Learn",
    requires: "signedIn",
    items: [
      {
        id: "scenarios",
        label: "Scenarios",
        to: "/scenarios",
        icon: BookOpen,
        requires: "signedIn",
      },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    requires: "signedIn",
    items: [
      {
        id: "runs",
        label: "My runs",
        to: "/runs",
        icon: ListChecks,
        requires: "signedIn",
      },
    ],
  },
  {
    id: "teams",
    label: "Teams",
    requires: "signedIn",
    items: [
      {
        id: "teams",
        label: "Teams",
        to: "/teams",
        icon: Users,
        requires: "signedIn",
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    requires: "signedIn",
    items: [
      {
        id: "profile",
        label: "Profile",
        to: "/profile",
        icon: User,
        requires: "signedIn",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    requires: "admin",
    items: [
      {
        id: "admin-overview",
        label: "Overview",
        to: "/admin",
        icon: LayoutDashboard,
        requires: "admin",
        matchPrefix: "/admin",
      },
      {
        id: "admin-hosts",
        label: "Host onboarding",
        to: "/admin/onboarding",
        icon: Server,
        requires: "admin",
      },
      {
        id: "admin-builds",
        label: "Builds",
        to: "/admin/builds",
        icon: Hammer,
        requires: "admin",
      },
      {
        id: "admin-scenarios",
        label: "Scenario registry",
        to: "/admin/scenarios",
        icon: Library,
        requires: "admin",
      },
    ],
  },
];

/** Flat list of every nav item, for breadcrumb label lookup. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

// Longest-prefix match so `/admin/builds` beats `/admin`.
export function findActiveNavItem(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  let bestLen = -1;
  for (const item of NAV_ITEMS) {
    const prefix = item.matchPrefix ?? item.to;
    const matches = pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (matches && prefix.length > bestLen) {
      best = item;
      bestLen = prefix.length;
    }
  }
  return best;
}
