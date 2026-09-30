import { useEffect } from "react";

const PRODUCT = "LogisticBay Timesheets";

/**
 * Sets the document title for the page being shown. `null` means the page is
 * the product's own front page, which carries the product name alone.
 */
export function usePageTitle(page: string | null): void {
  useEffect(() => {
    document.title = page === null ? PRODUCT : `${page} · ${PRODUCT}`;
  }, [page]);
}
