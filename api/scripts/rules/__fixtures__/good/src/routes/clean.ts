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
