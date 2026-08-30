export function leak(req) {
  return req.body.companyId;
}
export const ctx = TenantContext.trust({ companyId: "a", userId: "b", membershipId: "c" });
export const rows = prisma.shiftSegment.findMany({});
