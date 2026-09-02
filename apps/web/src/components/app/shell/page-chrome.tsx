import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";

/**
 * Everything a page can contribute to the app shell. One writer per route:
 * a page registers its chrome once via usePageChrome. Pages that re-render on
 * timers must memoize their node fields — every new element identity re-renders
 * the shell chrome.
 */
export interface PageChrome {
  /** Human label for the final crumb — the page's h1. */
  title?: string | null | undefined;
  /** One small status token (StatusToken/Badge) shown right of the crumbs. */
  status?: ReactNode;
  /** Optional cross-flow return link shown before the page title. */
  back?: ReactNode;
  /** Optional compact page utility, such as the mobile course outline. */
  utility?: ReactNode;
  /** THE one primary page action: a single small Button. */
  action?: ReactNode;
  /** Overflow DropdownMenuItem elements; the ⋯ menu renders only when set. */
  menu?: ReactNode;
  /** Labels for route ancestors when a catalog supplies human-readable names. */
  breadcrumbLabels?: Readonly<Record<string, string>> | undefined;
  /**
   * Lets a live run take over the viewport. This is internal shell state, not
   * a browser Fullscreen API request.
   */
  fullscreen?: boolean | undefined;
}

interface PageChromeSetters {
  set: (path: string, chrome: PageChrome) => void;
  clear: (path: string) => void;
}

interface PageChromeValue {
  chrome: ReadonlyMap<string, PageChrome>;
}

// Split contexts: pages subscribe only to the stable setters, the bar alone
// subscribes to the value — a chrome write never re-renders the page that
// registered it (the loop hazard useBreadcrumbLabel always documented).
const PageChromeSetterContext = createContext<PageChromeSetters | null>(null);
const PageChromeValueContext = createContext<PageChromeValue | null>(null);

function chromeEquals(a: PageChrome | undefined, b: PageChrome): boolean {
  return (
    a !== undefined &&
    a.title === b.title &&
    Object.is(a.status, b.status) &&
    Object.is(a.back, b.back) &&
    Object.is(a.utility, b.utility) &&
    Object.is(a.action, b.action) &&
    Object.is(a.menu, b.menu) &&
    a.fullscreen === b.fullscreen &&
    equalBreadcrumbLabels(a.breadcrumbLabels, b.breadcrumbLabels)
  );
}

function equalBreadcrumbLabels(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([path, label]) => right?.[path] === label)
  );
}

export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [chrome, setChrome] = useState<Map<string, PageChrome>>(
    () => new Map(),
  );

  const set = useCallback((path: string, next: PageChrome) => {
    setChrome((current) => {
      if (chromeEquals(current.get(path), next)) return current;
      const map = new Map(current);
      map.set(path, next);
      return map;
    });
  }, []);

  const clear = useCallback((path: string) => {
    setChrome((current) => {
      if (!current.has(path)) return current;
      const map = new Map(current);
      map.delete(path);
      return map;
    });
  }, []);

  const setters = useMemo(() => ({ set, clear }), [set, clear]);
  const value = useMemo(() => ({ chrome }), [chrome]);

  return (
    <PageChromeSetterContext.Provider value={setters}>
      <PageChromeValueContext.Provider value={value}>
        {children}
      </PageChromeValueContext.Provider>
    </PageChromeSetterContext.Provider>
  );
}

/** Shell reader: the chrome registered for the current pathname. */
export function usePageChromeValue(pathname: string): PageChrome | undefined {
  return useContext(PageChromeValueContext)?.chrome.get(pathname);
}

/** Bar-only reader: title overrides for crumb labels, keyed by path. */
export function useBreadcrumbOverrides(): ReadonlyMap<string, string> {
  const value = useContext(PageChromeValueContext);
  return useMemo(() => {
    const titles = new Map<string, string>();
    for (const [path, chrome] of value?.chrome ?? []) {
      for (const [breadcrumbPath, label] of Object.entries(
        chrome.breadcrumbLabels ?? {},
      )) {
        titles.set(breadcrumbPath, label);
      }
      if (chrome.title) titles.set(path, chrome.title);
    }
    return titles;
  }, [value?.chrome]);
}

/**
 * Register the current route's bar chrome. One caller per page — a second
 * caller on the same route replaces the first wholesale.
 */
export function usePageChrome(chrome: PageChrome): void {
  const setters = useContext(PageChromeSetterContext);
  const set = setters?.set;
  const clear = setters?.clear;
  // Key by the COMMITTED location, not the eager one — during a pending
  // navigation the router's location already points at the destination while
  // this page is still the one on screen; registering under that path would
  // put this page's h1/actions on the next route's crumb.
  const pathname = useRouterState({
    select: (state) =>
      state.resolvedLocation?.pathname ?? state.location.pathname,
  });
  const {
    title,
    status,
    back,
    utility,
    action,
    menu,
    breadcrumbLabels,
    fullscreen,
  } = chrome;

  useEffect(() => {
    if (!set || !clear) return;
    if (
      title == null &&
      !status &&
      !back &&
      !utility &&
      !action &&
      !menu &&
      !breadcrumbLabels &&
      !fullscreen
    ) {
      return;
    }
    set(pathname, {
      title,
      status,
      back,
      utility,
      action,
      menu,
      breadcrumbLabels,
      fullscreen,
    });
    return () => clear(pathname);
  }, [
    set,
    clear,
    pathname,
    title,
    status,
    back,
    utility,
    action,
    menu,
    breadcrumbLabels,
    fullscreen,
  ]);
}
