import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isAdminUser } from "@/lib/authz";
import { useMyRuns } from "../hooks/useMyRuns";
import { useSession } from "../hooks/useSession";
import { NAV_SECTIONS, findActiveNavItem } from "./nav-config";
import { SidebarUserMenu } from "./SidebarUserMenu";
import { BrandMark } from "../patterns/BrandMark";

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data } = useSession();
  const isAdmin = isAdminUser(data?.user ?? null);
  const activeId = findActiveNavItem(pathname)?.id ?? null;
  const runs = useMyRuns();
  const activeRunCount =
    runs.data?.runs.filter((run) => run.active).length ?? 0;

  const sections = NAV_SECTIONS.filter(
    (section) => section.requires !== "admin" || isAdmin,
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <BrandMark
          to="/scenarios"
          className="px-1.5 group-data-[collapsible=icon]:[&_span]:hidden"
        />
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => {
          const items = section.items.filter(
            (item) => item.requires !== "admin" || isAdmin,
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={section.id}>
              {section.label ? (
                <SidebarGroupLabel className="text-eyebrow text-[0.68rem] text-sidebar-foreground/75">
                  {section.label}
                </SidebarGroupLabel>
              ) : null}
              <SidebarMenu>
                {items.map((item) => {
                  const Icon = item.icon;
                  const badgeCount =
                    item.id === "runs" ? activeRunCount : 0;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={activeId === item.id}
                        tooltip={item.label}
                        render={<Link to={item.to} />}
                      >
                        <Icon />
                        <span>{item.label}</span>
                        {badgeCount > 0 ? (
                          <span className="sr-only">
                            , {badgeCount} active
                          </span>
                        ) : null}
                      </SidebarMenuButton>
                      {badgeCount > 0 ? (
                        <SidebarMenuBadge className="text-primary">
                          {badgeCount}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <SidebarUserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
