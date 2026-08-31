/**
 * The trusted tenant identity a repository operates under.
 *
 * This is the ONLY object repositories accept as tenant authority. It is
 * deliberately a class with a private field, which makes the type NOMINAL: a
 * structurally identical object literal — say, one built from a request body —
 * does not satisfy it, and `tsc` rejects it at the call site. The SANCTIONED
 * way to obtain one is `TenantContext.trust()`, whose name is meant to read as
 * a liability: whoever calls it is vouching that these identifiers came from
 * server-side authority (a verified token + membership row — AUTH.md), never
 * from client input. In production that call has exactly one site,
 * `authorizeTenant` in lib/authorization.ts.
 *
 * Sanctioned is not the same as only, and the difference is deliberate to state
 * (F-22). A double cast — `x as unknown as TenantContext` — manufactures one
 * without calling `trust()`, compiles clean under `strict`, and no rule flags
 * it. No TypeScript construct can prevent that, so this class raises the cost
 * of the mistake; it does not make it impossible. What it DOES guarantee at
 * runtime is that a context, once built, cannot be altered: the instance is
 * frozen in the constructor, so a downstream holder cannot repoint the company
 * it is scoped to, and cannot bolt a capability onto it. Proven in
 * ./tenantContext.test.ts.
 *
 * check-rules restricts where `.trust(` may appear (auth middleware, tests,
 * seeds), with a known-wide exemption — see F-23. That is friction, not proof:
 * per D16 the guarantee is the repository boundary plus the database composite
 * keys, proven by the Company A/B tests in src/tests/db/.
 */
export class TenantContext {
  /** Nominal-typing brand; also handy in logs. */
  private readonly kind = "TenantContext";

  private constructor(
    /** The company every query in this context is scoped to. */
    readonly companyId: string,
    /** The authenticated person. */
    readonly userId: string,
    /** The membership that authorises acting for this company (D15). */
    readonly membershipId: string,
  ) {
    // `readonly` is erased at runtime, so without this the authority object is
    // an ordinary mutable one and anything holding it can re-scope it. Last
    // statement in the constructor, after every field is assigned. ESM is
    // strict mode, so a later write throws rather than silently doing nothing.
    Object.freeze(this);
  }

  /**
   * Assert that these identifiers come from trusted server-side authority.
   * Calling this with anything derived from a request body/query/params is a
   * tenant-isolation bug, whatever the types say.
   */
  static trust(source: { companyId: string; userId: string; membershipId: string }): TenantContext {
    return new TenantContext(source.companyId, source.userId, source.membershipId);
  }

  /** For log lines; never expose in API responses. */
  describe(): string {
    return `${this.kind}(company=${this.companyId}, membership=${this.membershipId})`;
  }
}
