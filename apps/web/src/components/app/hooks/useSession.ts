import { useQuery } from "@tanstack/react-query";
import { getClientSession } from "@/lib/auth-client";

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: getClientSession,
    staleTime: 30_000,
    retry: 1,
  });
}
