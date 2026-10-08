/**
 * Test support: a stand-in database for app-level tests that must not reach
 * PostgreSQL. Every read finds nothing; every write REJECTS, so a test that
 * wanders into one fails loudly. `counters.sessionReads` counts Session
 * lookups — what authentication costs a request (F-15).
 */
export function emptyDatabase() {
  const counters = { sessionReads: 0 };
  const refuse = (what: string) => () => Promise.reject(new Error(`${what} is not part of this test`));
  const db = {
    $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> => Promise.resolve([{ ok: 1 }]),
    session: {
      findUnique: (): Promise<null> => {
        counters.sessionReads += 1;
        return Promise.resolve(null);
      },
      updateMany: () => Promise.resolve({ count: 0 }),
      create:     refuse("session.create"),
    },
    companyMembership: {
      findUnique: (): Promise<null> => Promise.resolve(null),
      findFirst:  (): Promise<null> => Promise.resolve(null),
      findMany:   () => Promise.resolve([]),
    },
    shift: {
      count:     () => Promise.resolve(0),
      create:    refuse("shift.create"),
      findFirst: () => Promise.resolve(null),
    },
    company: { findUnique: () => Promise.resolve(null) },
    user: {
      findUnique: () => Promise.resolve(null),
      findFirst:  () => Promise.resolve(null),
      create:     refuse("user.create"),
    },
    pendingCompanyRegistration: {
      findUnique: () => Promise.resolve(null),
      create:     refuse("pendingCompanyRegistration.create"),
    },
    emailSuppression:   { findMany: () => Promise.resolve([]) },
    emailMessage:       { create: refuse("emailMessage.create") },
    emailDeliveryEvent: { findUnique: () => Promise.resolve(null) },
    accountToken: {
      upsert:     refuse("accountToken.upsert"),
      findUnique: () => Promise.resolve(null),
      findFirst:  () => Promise.resolve(null),
    },
    $transaction: refuse("$transaction"),
  };
  return { db, counters };
}
