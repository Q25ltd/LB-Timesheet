export function leak(req) {
  return req.body.companyId;
}
export const ctx = TenantContext.trust({ companyId: "a", userId: "b", membershipId: "c" });
export const rows = prisma.shiftSegment.findMany({});
export const submission = SubmissionContext.trust({ userId: "u", membershipId: "m", companyId: "c", membershipActive: false });
