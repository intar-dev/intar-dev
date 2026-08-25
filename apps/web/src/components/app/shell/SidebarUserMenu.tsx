import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { authClient } from "@/lib/auth-client";
import { clearAllTemporaryNativeSshKeys } from "@/lib/temporary-native-ssh-storage";
import { useSession } from "../hooks/useSession";
import { useTheme, type AppTheme } from "../theme";

export function SidebarUserMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const { data } = useSession();
  const user = data?.user ?? null;
  const username = user?.username ?? user?.email ?? "Account";

  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if ("error" in result && result.error) {
        throw new Error(result.error.message ?? "Failed to sign out");
      }
      return result;
    },
    onSuccess: () => {
      clearAllTemporaryNativeSshKeys();
      queryClient.clear();
      void navigate({ to: "/" });
    },
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
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
                  <UserIcon className="size-4" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{username}</span>
                  {user.email ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  ) : null}
                </span>
                <ChevronsUpDown className="ml-auto size-4" />
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
