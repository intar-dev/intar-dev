import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isAdminUser } from "@/lib/authz";
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
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={activeId === item.id}
                        tooltip={item.label}
                        render={<Link to={item.to} />}
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
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
