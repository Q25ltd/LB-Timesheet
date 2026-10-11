import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useLinkToken } from "../../auth/useLinkToken";
import { PATHS } from "../../paths";
import { confirmReportEmail } from "../company/companySettingsApi";
import { AuthCard } from "./AuthCard";

type Shown = { kind: "confirmed"; companyName: string } | { kind: "invalid" } | { kind: "unavailable" } | null;

/**
 * CONFIRM A REPORT ADDRESS (D66; `/confirm-report-email`) — where the link a
 * company's administrator asked for lands. Public: the token in the link is
 * the credential; whoever reads the mailbox confirms that reports may be
 * sent to it. It confirms that one address for that one company, once.
 */
export function ConfirmReportEmailPage() {
  const token = useLinkToken();
  const [shown, setShown] = useState<Shown>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (token === undefined || sent.current) return;
    sent.current = true;
    if (token === null) { setShown({ kind: "invalid" }); return; }
    void confirmReportEmail(token).then(result => {
      if (result.kind === "ok") setShown({ kind: "confirmed", companyName: result.value.companyName });
      else setShown(result.kind === "refused" && result.status === 400 ? { kind: "invalid" } : { kind: "unavailable" });
    });
  }, [token]);

  const home = <p className="auth-card__switch"><Link to={PATHS.home}>LogisticBay Timesheets home</Link></p>;
  if (shown === null) {
    return (
      <AuthCard title="Confirming the report address" intro="Just a moment." footer={home}>
        <p className="verify__line" role="status">Confirming…</p>
      </AuthCard>
    );
  }
  if (shown.kind === "confirmed") {
    return (
      <AuthCard title="Report address confirmed" intro={`Timesheets ${shown.companyName}'s drivers submit will be emailed to this address.`} footer={home}>
        <p className="verify__line" role="status">You can close this page.</p>
      </AuthCard>
    );
  }
  if (shown.kind === "invalid") {
    return (
      <AuthCard title="This link cannot be used" intro="It has already been used, it has expired, or the company has since changed its report address." footer={home}>
        <p className="verify__line" role="alert">Ask the company&apos;s administrator to send a new link from Settings.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="We could not confirm the address" intro="Nothing has changed. Check your connection, then open the link again." footer={home}>
      <p className="verify__line" role="alert">The link still works until it expires.</p>
    </AuthCard>
  );
}
