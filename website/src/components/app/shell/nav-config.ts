import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  FileCode2,
  Hammer,
  LayoutDashboard,
  Library,
  ListChecks,
  Server,
  UserPlus,
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
  /** Omitted for the primary group — it renders without a group label. */
  label?: string;
  requires: NavRequirement;
  items: NavItem[];
}

// Single source of truth for the sidebar and breadcrumb labels. Role filtering
// happens at render time via `isAdminUser`. Profile intentionally has no nav
// item — it lives in the sidebar user menu.
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
        matchPrefix: "/scenarios",
      },
      {
        id: "runs",
        label: "My runs",
        to: "/runs",
        icon: ListChecks,
        requires: "signedIn",
        matchPrefix: "/runs",
      },
      {
        id: "organizations",
        label: "Organizations",
        to: "/organizations",
        icon: Users,
        requires: "signedIn",
        matchPrefix: "/organizations",
      },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    requires: "admin",
    items: [
      {
        id: "admin-overview",
        label: "Overview",
        to: "/admin",
        icon: LayoutDashboard,
        requires: "admin",
      },
      {
        id: "admin-hosts",
        label: "Hosts",
        to: "/admin/hosts",
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
    ],
  },
  {
    id: "content-access",
    label: "Content & access",
    requires: "admin",
    items: [
      {
        id: "admin-scenarios",
        label: "Scenarios",
        to: "/admin/scenarios",
        icon: Library,
        requires: "admin",
      },
      {
        id: "admin-authoring",
        label: "Authoring",
        to: "/admin/authoring",
        icon: FileCode2,
        requires: "admin",
      },
      {
        id: "admin-people",
        label: "People",
        to: "/admin/people",
        icon: UserPlus,
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
