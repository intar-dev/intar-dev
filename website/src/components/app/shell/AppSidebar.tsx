import { Link, useRouterState } from "@tanstack/react-router";
import { SquareTerminal } from "lucide-react";
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
        <Link
          to="/scenarios"
          className="flex items-center gap-2 px-1.5 py-1 font-semibold tracking-tight"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <SquareTerminal className="size-4" />
          </span>
          <span className="group-data-[collapsible=icon]:hidden">intar</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => {
          const items = section.items.filter(
            (item) => item.requires !== "admin" || isAdmin,
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={section.id}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
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
