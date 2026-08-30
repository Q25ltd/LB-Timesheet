import { PrismaClient } from "../generated/client.js";
export const BadDto = { companyId: z.string() };
export async function handler(req: any, reply) {
  const { companyId } = req.body;
  console.log(companyId);
  reply.status(400).send({ error: "inline" });
  svc.create(auth, req.body);
  jwt.verify(token, secret);
  prisma.shift.findUnique({ where: { id: companyId } });
  promise.catch(() => {});
  const c2 = req.body?.companyId;
}
const {
  companyId: crossLine,
} = req.query;
