// The frozen access-token claims contract (AUTH.md). companyId here is a
// server-issued, cryptographically verified claim -- not client request input
// -- and it is cross-checked against the persisted CompanyMembership before it
// becomes authority. Legitimate precisely because token verification is
// confined to this module by `jwt-centralised`.
export const AccessTokenClaims = z.object({
  sub:          z.string().max(64),
  companyId:    z.string().max(64),
  membershipId: z.string().max(64),
  sessionId:    z.string().max(64),
});

export function verifyAccessToken(token: string, secret: string): unknown {
  return jwt.verify(token, secret);
}
