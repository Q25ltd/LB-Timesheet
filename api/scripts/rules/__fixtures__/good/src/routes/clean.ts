import { z } from "zod";
export const CreateShift = z.object({
  driverName: z.string().max(200),
  membershipId: z.string().max(64),
});
export async function handler(req: unknown, reply: Reply, auth: AuthContext) {
  const dto = CreateShift.parse((req as { body: unknown }).body);
  const { membershipId } = dto;
  const companyId = auth.companyId;
  const body = await render(dto);
  reply.send(body);
  mailer.send(to, subject, body);
  app.log.info({ companyId: auth.companyId, path: id });
  return svc.list(auth.companyId, dto, membershipId);
}
// A route that DECLARES its posture. Present so the good fixture proves the
// rule ACCEPTS a valid declaration (D21's three postures), not merely that it
// stays quiet when no route is registered at all — a regex that matched
// nothing would otherwise pass this fixture silently.
app.get("/clean", { config: { authPosture: "tenant" } }, handler);
