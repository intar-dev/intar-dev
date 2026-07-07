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

interface BreadcrumbOverrides {
  overrides: ReadonlyMap<string, string>;
  setOverride: (path: string, label: string) => void;
  clearOverride: (path: string) => void;
}

const BreadcrumbContext = createContext<BreadcrumbOverrides | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<Map<string, string>>(
    () => new Map(),
  );

  const setOverride = useCallback((path: string, label: string) => {
    setOverrides((current) => {
      if (current.get(path) === label) return current;
      const next = new Map(current);
      next.set(path, label);
      return next;
    });
  }, []);

  const clearOverride = useCallback((path: string) => {
    setOverrides((current) => {
      if (!current.has(path)) return current;
      const next = new Map(current);
      next.delete(path);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ overrides, setOverride, clearOverride }),
    [overrides, setOverride, clearOverride],
  );

  return (
    <BreadcrumbContext.Provider value={value}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumbOverrides(): ReadonlyMap<string, string> {
  return useContext(BreadcrumbContext)?.overrides ?? new Map();
}

/**
 * Replace the raw id segment of the current route with a human label once the
 * page has loaded its data (e.g. the scenario title on a run page).
 *
 * Depends on the stable setter callbacks, NOT the context value — the value's
 * identity changes with every override write, which would loop the effect.
 */
export function useBreadcrumbLabel(label: string | null | undefined) {
  const context = useContext(BreadcrumbContext);
  const setOverride = context?.setOverride;
  const clearOverride = context?.clearOverride;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  useEffect(() => {
    if (!setOverride || !clearOverride || !label) return;
    setOverride(pathname, label);
    return () => clearOverride(pathname);
  }, [setOverride, clearOverride, label, pathname]);
}
