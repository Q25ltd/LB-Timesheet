/**
 * The storage scope for the account signed in NOW (F-31) — or `null` when no
 * account is signed in, or while the scope for a newly signed-in account is
 * being made.
 *
 * Made from the server-confirmed `account.user.id` the AuthProvider holds,
 * never from anything stored on the phone. Each scope lives exactly as long
 * as that account stays signed in on this screen: when the driver signs out,
 * another account signs in, or the screen goes away, the scope is REVOKED,
 * so work still in flight for the previous driver is refused by the store
 * rather than completed. There is no module-level "current user" — every
 * screen holds the scope it was given and passes it to every storage call.
 */
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { AccountScope } from "./accountScope";

export function useAccountScope(): AccountScope | null {
  const { account } = useAuth();
  const userId = account?.user.id ?? null;
  const [scope, setScope] = useState<AccountScope | null>(null);

  useEffect(() => {
    if (userId === null) {
      setScope(null);
      return undefined;
    }
    let made: AccountScope;
    try {
      made = AccountScope.forAccount({ id: userId });
    } catch {
      // An account id that cannot name a directory reaches no storage.
      setScope(null);
      return undefined;
    }
    setScope(made);
    return () => {
      made.revoke();
      setScope(null);
    };
  }, [userId]);

  // Never hand out a scope for an account that is no longer the signed-in one,
  // even for the render before the effect above has caught up.
  return scope !== null && scope.userId === userId ? scope : null;
}
