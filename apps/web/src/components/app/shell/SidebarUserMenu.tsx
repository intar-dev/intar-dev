import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronsUpDown,
  Laptop2,
  LogOut,
  Moon,
  Sun,
  User as UserIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSession } from "../hooks/useSession";
import { useSignOut } from "../hooks/useSignOut";
import { useTheme, type AppTheme } from "../theme";

export function SidebarUserMenu() {
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const { data } = useSession();
  const user = data?.user ?? null;
  const username = user?.username ?? user?.email ?? "Account";

  const signOut = useSignOut({
    onSignedOut: () => void navigate({ to: "/" }),
  });

  if (!user) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <span
                  aria-hidden="true"
                  className="flex size-7.5 shrink-0 items-center justify-center rounded-full bg-accent text-[0.8125rem] font-semibold text-foreground ring-1 ring-border"
                >
                  {username.slice(0, 1).toUpperCase()}
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium text-foreground">{username}</span>
                  {user.email ? (
                    <span className="truncate text-xs font-normal text-faint-foreground">
                      {user.email}
                    </span>
                  ) : null}
                </span>
                <ChevronsUpDown className="ml-auto size-4 text-faint-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={8}
            className="min-w-56"
          >
            {/* Base UI requires GroupLabel to live inside a Menu.Group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">
                {username}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/profile" />}>
              <UserIcon className="size-4" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value) => setTheme(value as AppTheme)}
              >
                <DropdownMenuRadioItem value="light">
                  <Sun className="size-4" />
                  Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon className="size-4" />
                  Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  <Laptop2 className="size-4" />
                  System
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              <LogOut className="size-4" />
              {signOut.isPending ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
