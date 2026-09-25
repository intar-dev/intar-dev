import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { clearAllTemporaryNativeSshKeys } from "@/lib/temporary-native-ssh-storage";

/**
 * Signs out and forgets the account in this tab: cached queries and the
 * temporary SSH private keys it downloaded, so the next account can't use
 * them.
 */
export function useSignOut(options?: { onSignedOut?: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
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
      options?.onSignedOut?.();
    },
  });
}
