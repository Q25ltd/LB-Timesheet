export const Bounded = z.object({ note: z.string().max(4000) });
export const ok = value.catch((error: unknown) => log.error({ err: error }));
