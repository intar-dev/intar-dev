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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "../lib/format";
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
                // Named in the collapsed rail, where only the avatar shows.
                tooltip={username}
                className="font-normal tracking-normal"
              >
                {/* The username beside it is the accessible name. */}
                <Avatar aria-hidden="true">
                  {user.image ? <AvatarImage src={user.image} alt="" /> : null}
                  <AvatarFallback>{initials(username)}</AvatarFallback>
                </Avatar>
                <span className="grid flex-1 text-left">
                  <span className="truncate text-support font-medium text-foreground">{username}</span>
                  {user.email ? (
                    <span className="truncate text-caption font-normal text-faint-foreground">
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
        {/* The menu has closed by the time a sign out fails, so say so here,
            where the action was taken. */}
        {signOut.isError ? (
          <p
            role="alert"
            className="px-2.5 pt-1 text-caption text-destructive group-data-[collapsible=icon]:sr-only"
          >
            Couldn’t sign out. Try again.
          </p>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
