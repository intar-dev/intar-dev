import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { isAdminUser } from "@/lib/authz";
import { useMyRunsSummary } from "../hooks/useMyRuns";
import { useSession } from "../hooks/useSession";
import { NAV_SECTIONS, findActiveNavItem } from "./nav-config";
import { SidebarUserMenu } from "./SidebarUserMenu";
import { BrandMark } from "../patterns/BrandMark";
import { RollingNumber } from "@/components/app/patterns/RollingNumber";

/**
 * Glides the pill in from where it left: the rect the outgoing pill had when
 * it unmounted (mid-glide on a rapid second pick), else the row it left. The
 * pill lives in the current row, so it is always placed right, however the
 * sidebar collapses or scrolls; the glide only measures at the moment the page
 * changes.
 */
function glideFrom(
  pill: HTMLElement | null,
  from: Element | DOMRect | null | undefined,
) {
  if (!pill || !from) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const before = from instanceof DOMRect ? from : from.getBoundingClientRect();
  const after = pill.getBoundingClientRect();
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if (!dx && !dy) return;
  const style = getComputedStyle(pill);
  pill.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    {
      duration: Number.parseFloat(style.getPropertyValue("--duration-slow")) || 300,
      easing: style.getPropertyValue("--ease-enter").trim() || "ease-out",
    },
  );
}

/** Moves the hover ghost onto a row, measured inside the scrolling list. */
function placeGhost(ghost: HTMLElement, row: Element, list: HTMLElement) {
  const box = list.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const x = rect.left - box.left - list.clientLeft + list.scrollLeft;
  const y = rect.top - box.top - list.clientTop + list.scrollTop;
  ghost.style.transform = `translate(${x}px, ${y}px)`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
}

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data } = useSession();
  const isAdmin = isAdminUser(data?.user ?? null);
  const activeId = findActiveNavItem(pathname)?.id ?? null;
  const runs = useMyRunsSummary();
  const ongoingRunCount = runs.data?.activeCount ?? 0;
  const { isMobile, setOpenMobile } = useSidebar();
  const list = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement | null>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const lastActive = useRef(activeId);
  // Where the outgoing pill was when it unmounted, in-flight glide included.
  const leftPillRect = useRef<DOMRect | null>(null);
  const pillRef = useCallback((el: HTMLSpanElement | null) => {
    pill.current = el;
    return () => {
      if (el) leftPillRect.current = el.getBoundingClientRect();
    };
  }, []);
  // The count shrinks away still showing its last number, not "0".
  const [shownCount, setShownCount] = useState(ongoingRunCount);

  useEffect(() => {
    if (ongoingRunCount > 0) setShownCount(ongoingRunCount);
  }, [ongoingRunCount]);

  useLayoutEffect(() => {
    const from = lastActive.current;
    lastActive.current = activeId;
    if (!from || from === activeId) return;
    if (ghost.current) delete ghost.current.dataset.on;
    const left = leftPillRect.current;
    leftPillRect.current = null;
    glideFrom(
      pill.current,
      left ?? list.current?.querySelector(`[data-nav-row="${from}"]`),
    );
  }, [activeId]);

  // Choosing a destination closes the phone and tablet drawer.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
    // Only a change of page closes it, not the drawer opening.
  }, [pathname]);

  const sections = NAV_SECTIONS.filter(
    (section) => section.requires !== "admin" || isAdmin,
  );

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        {/* The wordmark fades while the rail narrows and the link clips it. */}
        <BrandMark
          to="/courses"
          className="overflow-hidden px-2 group-data-[collapsible=icon]:px-1 [&>span]:transition-opacity [&>span]:duration-(--duration-fast) [&>span]:ease-standard group-data-[collapsible=icon]:[&>span]:opacity-0"
        />
      </SidebarHeader>

      <SidebarContent
        ref={list}
        render={<nav aria-label="Main" />}
        className="relative"
        onPointerOver={(event) => {
          // The ghost follows the mouse only: touch has no hover, so a tap
          // would leave it behind. Gaps and labels leave it where it is.
          if (event.pointerType !== "mouse") return;
          const target = ghost.current;
          const row = (event.target as Element).closest<HTMLElement>(
            "[data-nav-row]",
          );
          if (!target || !row || !list.current) return;
          if (row.dataset.navRow === activeId) {
            delete target.dataset.on;
            return;
          }
          // Appear in place when arriving from outside; glide between rows.
          const arriving = target.dataset.on === undefined;
          if (arriving) delete target.dataset.glide;
          placeGhost(
            target,
            row.querySelector('[data-sidebar="menu-button"]') ?? row,
            list.current,
          );
          if (arriving) void target.offsetWidth;
          target.dataset.glide = "";
          target.dataset.on = "";
        }}
        onPointerLeave={() => {
          if (ghost.current) delete ghost.current.dataset.on;
        }}
      >
        <span ref={ghost} aria-hidden="true" data-nav-ghost />
        {sections.map((section) => {
          const items = section.items.filter(
            (item) => item.requires !== "admin" || isAdmin,
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={section.id}>
              {section.label ? (
                <SidebarGroupLabel>
                  {section.label}
                </SidebarGroupLabel>
              ) : null}
              <SidebarMenu>
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = !item.external && activeId === item.id;
                  const badgeCount =
                    item.id === "runs" ? ongoingRunCount : 0;
                  // Exactly one row is current: the one the pill sits on.
                  // Link's own fuzzy match would also mark ancestors such as
                  // Overview on /admin/hosts.
                  const destination = item.external ? (
                    <a
                      href={item.to}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  ) : (
                    <Link
                      to={item.to}
                      activeOptions={{ exact: true }}
                      aria-current={active ? "page" : undefined}
                    />
                  );
                  return (
                    <SidebarMenuItem key={item.id} data-nav-row={item.id}>
                      {active ? (
                        <span ref={pillRef} aria-hidden="true" data-nav-pill />
                      ) : null}
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={
                          item.external
                            ? `${item.label} (opens in a new tab)`
                            : item.label
                        }
                        render={destination}
                        // The pill and the ghost paint the row, not the row itself.
                        className="relative hover:bg-transparent data-active:bg-transparent data-active:shadow-none data-active:hover:bg-transparent data-active:active:bg-transparent!"
                      >
                        <Icon />
                        <span>{item.label}</span>
                        {item.external ? (
                          <ArrowUpRight
                            aria-hidden="true"
                            className="ml-auto size-3.5! opacity-60"
                          />
                        ) : null}
                        {item.external ? (
                          <span className="sr-only">
                            (opens in a new tab)
                          </span>
                        ) : null}
                        {badgeCount > 0 ? (
                          <span className="sr-only">
                            , {badgeCount} ongoing {badgeCount === 1 ? "run" : "runs"}
                          </span>
                        ) : null}
                      </SidebarMenuButton>
                      {item.id === "runs" && runs.data ? (
                        // Mounted once the summary is in, so the count is already
                        // in place on load. It pops in only when it crosses from
                        // zero, rolls while it changes, and shrinks away at zero.
                        // Its dot is the frame's pulse.
                        <SidebarMenuBadge
                          aria-hidden="true"
                          data-zero={badgeCount === 0 || undefined}
                          className="gap-1.5 transition-[opacity,scale] duration-(--duration-moderate) ease-enter data-zero:scale-(--scale-pop) data-zero:opacity-0 data-zero:duration-(--duration-fast) data-zero:ease-exit"
                        >
                          <span
                            className={
                              badgeCount > 0
                                ? "size-2 rounded-full bg-primary text-primary motion-safe:animate-live"
                                : "size-2 rounded-full bg-primary"
                            }
                          />
                          {/* Crossing zero pops instead of rolling. */}
                          <RollingNumber
                            key={badgeCount > 0 ? "on" : "off"}
                            value={badgeCount || shownCount}
                          />
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
