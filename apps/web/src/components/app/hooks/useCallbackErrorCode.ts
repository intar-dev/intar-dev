import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

/**
 * The `?error` code a redirect brought to this page. The page keeps it and
 * drops it from the URL, so a reload or a later attempt shows no stale
 * failure; `clear` hides it once the person tries again. A URL that carries
 * more than the error keeps it: the landing page is also the OAuth provider's
 * login page, whose signed request must stay as it is.
 */
export function useCallbackErrorCode(): [string | null, () => void] {
  const navigate = useNavigate();
  const [code, setCode] = useState(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("error"),
  );
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("error")) return;
    params.delete("error");
    params.delete("error_description");
    if (params.size === 0) {
      void navigate({ to: ".", search: {}, replace: true });
    }
  }, [navigate]);
  return [code, () => setCode(null)];
}
