import { useQuery } from "@tanstack/react-query";
import {
  appBootstrapQueryOptions,
  type AppBootstrapData,
} from "@/lib/app-bootstrap";

export function sessionQueryOptions() {
  return {
    ...appBootstrapQueryOptions(),
    select: (bootstrap: AppBootstrapData) => bootstrap.session,
  };
}

export function useSession() {
  return useQuery(sessionQueryOptions());
}
