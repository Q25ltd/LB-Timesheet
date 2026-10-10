/**
 * WHOSE records a local storage operation may touch (F-31).
 *
 * A phone can be shared: driver A signs out and driver B signs in on the same
 * device. Every local record — the open day, its temporary and recovery
 * files, every finished day — therefore lives under ONE account's directory,
 * `accounts/<user.id>/`, and every read, write, update, recovery and delete
 * names the account it acts for by passing an `AccountScope`. There is no
 * default account and no module-level "current user": a call that does not
 * name its account cannot reach any record.
 *
 * A scope is ONLY made from the account the server confirmed at sign-in
 * (`AccountUser.id`, shape-checked by `api/account.ts`) — never from a
 * record, a route parameter or anything the device stored. Real scopes are
 * held in a private registry, so an object that merely LOOKS like a scope
 * (`{ userId: "someone-else" }`) is refused, and a REVOKED scope — the driver
 * signed out, or another account signed in — is refused on every later
 * access, including work that was already queued when it was revoked.
 *
 * Isolation holds at the storage layer, not in the UI: `localShift.ts` checks
 * the scope immediately before it touches a file, and checks every record's
 * `ownerUserId` against it when reading and before writing.
 */
import { Directory, Paths } from "expo-file-system";

/** The directory every account's records live under. */
export const ACCOUNTS_DIRECTORY = "accounts";

/**
 * An account id as the server issues it (a cuid today). Restricted so it can
 * only ever be ONE path segment: no separators, no `.`/`..`, nothing that
 * could name a directory other than the account's own.
 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A storage operation was asked to act without a valid, live account scope. */
export class AccountScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountScopeError";
  }
}

/** Every scope this module made and has not revoked. Never exported. */
const live = new WeakSet<AccountScope>();

export class AccountScope {
  /** The server-confirmed account these records belong to. */
  readonly userId: string;

  private constructor(userId: string) {
    this.userId = userId;
    Object.freeze(this);
  }

  /**
   * The scope for the account the server confirmed. Throws for anything that
   * is not a usable account id — no scope means no storage, never a
   * fallback directory.
   */
  static forAccount(user: { readonly id: unknown }): AccountScope {
    const { id } = user;
    if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id)) {
      throw new AccountScopeError("Refusing local storage for an account without a valid id");
    }
    const scope = new AccountScope(id);
    live.add(scope);
    return scope;
  }

  /** End this scope: every later storage access through it is refused. */
  revoke(): void {
    live.delete(this);
  }
}

/**
 * The scope, proven real and live — or a thrown `AccountScopeError`. Called
 * by the store immediately before every file access, so a scope revoked
 * while an operation waited in the write queue cannot complete it.
 */
export function assertLiveScope(scope: unknown): asserts scope is AccountScope {
  if (!(scope instanceof AccountScope) || !live.has(scope)) {
    throw new AccountScopeError("Refusing local storage without a live account scope");
  }
}

/** The account's own directory, `accounts/<user.id>/`, created on first use. */
export function accountDirectory(scope: AccountScope): Directory {
  assertLiveScope(scope);
  const directory = new Directory(Paths.document, ACCOUNTS_DIRECTORY, scope.userId);
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}
