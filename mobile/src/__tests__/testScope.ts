/**
 * Test support (F-31): the storage scope for the driver a test file signs in
 * — or, for a store test with no sign-in, a driver of its own.
 *
 * A REAL scope, made the way the app makes one, for a real account id: the
 * store's checks run exactly as they do in the app. A route under test makes
 * its own scope for the same signed-in account, so both reach the same
 * account's directory — never another's.
 */
import { Directory, Paths } from "expo-file-system";
import { ACCOUNTS_DIRECTORY, AccountScope } from "../shift/accountScope";

export function scopeFor(userId: string): AccountScope {
  return AccountScope.forAccount({ id: userId });
}

/** The account's own directory — where its records are, as the store files them. */
export function accountDirectoryOf(scope: AccountScope): Directory {
  const directory = new Directory(Paths.document, ACCOUNTS_DIRECTORY, scope.userId);
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}
