// A client request DTO defined OUTSIDE routes/ and imported by a route.
// This is the false-negative path a directory-scoped exemption would open:
// the schema is not in routes/ or services/, but a route parsing a body with
// it still lets client tenant identity across the boundary. Must be reported.
export const CreateShiftRequest = z.object({
  companyId: z.string().max(64),
  driverName: z.string().max(200),
});
