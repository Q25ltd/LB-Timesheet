import { fillAmount, type FillRecord } from "../shift/vehicleFill";

/** A stored fill's quantity, whichever shape it was stored in (D66) — `undefined` when there is no fill. */
export function quantityOf(fill: FillRecord | undefined): number | null | undefined {
  return fill === undefined ? undefined : fillAmount(fill).quantity;
}
