import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * The one-time token an emailed link carries in its FRAGMENT
 * (`#token=…`), which the browser never sends to a server.
 *
 * Read once, then removed from the address bar and from this history entry,
 * so it is not left behind for the back button, a screenshot or a shared
 * screen. `null` when the link carried none.
 */
export function useLinkToken(): string | null | undefined {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (token !== undefined) return;
    const match = /^#token=([A-Za-z0-9_-]{1,64})$/.exec(location.hash);
    setToken(match?.[1] ?? null);
    if (location.hash !== "") void navigate({ pathname: location.pathname, hash: "" }, { replace: true });
  }, [location.hash, location.pathname, navigate, token]);

  return token;
}
