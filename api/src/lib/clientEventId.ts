/**
 * The phone's id for one local day (D19, D66): a generated UUID, kept in its
 * CANONICAL form — lowercase, as RFC 9562 writes one and as the database's
 * check holds it. A UUID is case-insensitive, so `ABC…` and `abc…` are the
 * same day: normalised here, before anything looks it up or stores it, so the
 * same day can never become two, and a valid id never reaches the database's
 * check as a 500 (security review R4).
 */
import { z } from "zod";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const ClientEventId = z.uuid()
  .transform(value => value.toLowerCase())
  .refine(value => value !== NIL_UUID, "clientEventId must be a generated id");
