/**
 * The trusted tenant identity a repository operates under.
 *
 * This is the ONLY object repositories accept as tenant authority. It is
 * deliberately a class with a private field, which makes the type NOMINAL:
 * a structurally identical object literal — say, one built from a request
 * body — does not satisfy it. The single way to obtain one is
 * `TenantContext.trust()`, whose name is meant to read as a liability at the
 * call site: whoever calls it is vouching that these identifiers came from
 * server-side authority (a verified token + membership row — AUTH.md), never
 * from client input.
 *
 * check-rules restricts where `.trust(` may appear (auth middleware, tests,
 * seeds). That is friction, not proof — the proof is the Company A/B
 * repository tests in src/tests/db/.
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
  ) {}

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
