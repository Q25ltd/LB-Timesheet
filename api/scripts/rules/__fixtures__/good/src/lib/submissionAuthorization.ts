// The one legitimate call site: the membership was loaded by its id AND the signed-in user's id.
export async function authorizeTimesheetSubmission(identity, membershipId, memberships) {
  const row = await memberships.findOwnDriverMembership(identity.userId, membershipId);
  if (row === null) throw notFound();
  return SubmissionContext.trust({ userId: identity.userId, membershipId, companyId: row.companyId, membershipActive: row.active });
}
