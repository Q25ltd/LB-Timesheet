import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import type { ApiResult } from "../../auth/http";
import { Field, FormMessage } from "../../components/Field";
import { usePageTitle } from "../../usePageTitle";
import {
  addDriver, cancelInvitation, correctInvitation, listInvitations,
  type DriverInvitation, type InvitationStatus,
} from "./driverInvitationsApi";

/**
 * DRIVERS — the company adds its drivers (D63, stage 4; `/company/drivers`).
 *
 * The company types a driver's name and email address (and its own payroll
 * reference); that is an INVITATION, which the driver accepts in the phone
 * app with that address confirmed. Nothing here looks a driver up: the list
 * is what the company typed and what each driver answered. An invitation
 * that is still open can be corrected or cancelled; nothing else can.
 */
export function DriversPage() {
  usePageTitle("Drivers");
  const { withCompany } = useAuth();
  const [invitations, setInvitations] = useState<DriverInvitation[] | "loading" | "failed" | "forbidden">("loading");

  const reload = useCallback(async () => {
    const result = await listInvitations(withCompany);
    if (result.kind === "ok") setInvitations(result.value);
    else setInvitations(result.kind === "refused" && result.status === 403 ? "forbidden" : "failed");
  }, [withCompany]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="drivers">
      <header className="drivers__head">
        <h1 className="drivers__title">Drivers</h1>
        <p className="drivers__intro">
          Add the drivers who work for your company. Each one gets an invitation, and joins when they accept it in the
          LogisticBay Timesheets phone app, signed in with the email address you give here and confirmed there.
        </p>
      </header>

      {invitations === "forbidden" ? (
        <p className="drivers__notice" role="alert">Your account is not allowed to manage drivers for this company.</p>
      ) : (
        <>
          <AddDriver onAdded={reload} />
          <section className="drivers__list" aria-labelledby="drivers-list-title">
            <h2 id="drivers-list-title" className="company-section-title">Your drivers</h2>
            {invitations === "loading" ? <p className="drivers__notice" role="status">Loading your drivers…</p> : null}
            {invitations === "failed" ? (
              <p className="drivers__notice" role="alert">
                We could not load your drivers just now. Nothing has changed — try again in a moment.
                {" "}<button className="button button--secondary" type="button" onClick={() => void reload()}>Try again</button>
              </p>
            ) : null}
            {Array.isArray(invitations) && invitations.length === 0 ? (
              <p className="drivers__notice">No drivers yet. Add your first driver above.</p>
            ) : null}
            {Array.isArray(invitations) && invitations.length > 0 ? <DriverTable invitations={invitations} onChanged={reload} /> : null}
          </section>
        </>
      )}
    </div>
  );
}

type Errors = Partial<Record<"firstName" | "lastName" | "email", string>>;
const EMPTY = { firstName: "", lastName: "", email: "", payrollRef: "" };

function checked(fields: typeof EMPTY): Errors {
  const errors: Errors = {};
  if (fields.firstName.trim() === "") errors.firstName = "Enter the driver's first name.";
  if (fields.lastName.trim() === "") errors.lastName = "Enter the driver's last name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim())) errors.email = "Enter a valid email address.";
  return errors;
}

function addRefusal(result: Exclude<ApiResult<unknown>, { kind: "ok" }>): string {
  if (result.kind === "refused") {
    if (result.code === "ALREADY_A_DRIVER") return "This person is already one of your drivers.";
    if (result.code === "INVITATION_EXISTS") return "This email address already has an open invitation. You can correct or cancel it below.";
    if (result.code === "INVITATION_LIMIT") return "You have added the most drivers allowed in one day. Try again tomorrow.";
    if (result.status === 400) return "Check the driver's details and try again.";
    if (result.status === 403) return "Your account is not allowed to manage drivers for this company.";
  }
  return "We could not add the driver just now. Nothing was saved — try again in a moment.";
}

function AddDriver({ onAdded }: { onAdded: () => Promise<void> }) {
  const { withCompany } = useAuth();
  const [fields, setFields] = useState(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = checked(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setMessage(null);
    const payrollRef = fields.payrollRef.trim();
    const result = await addDriver(withCompany, {
      firstName: fields.firstName.trim(),
      lastName:  fields.lastName.trim(),
      email:     fields.email.trim(),
      ...(payrollRef === "" ? {} : { payrollRef }),
    });
    setBusy(false);
    if (result.kind !== "ok") {
      setMessage({ tone: "error", text: addRefusal(result) });
      return;
    }
    const { firstName, lastName, email } = result.value;
    // Said as an invitation, never as a driver who has joined (D63).
    setMessage({
      tone: "success",
      text: `You have invited ${firstName} ${lastName} (${email}). They join when they accept in the LogisticBay Timesheets app.`,
    });
    setFields(EMPTY);
    await onAdded();
  }

  const set = (key: keyof typeof EMPTY) => (event: { target: { value: string } }) => { setFields(previous => ({ ...previous, [key]: event.target.value })); };

  return (
    <section className="drivers__add" aria-labelledby="add-driver-title">
      <h2 id="add-driver-title" className="company-section-title">Add a driver</h2>
      <form className="auth-form drivers__form" onSubmit={event => void submit(event)} noValidate>
        <div className="drivers__form-row">
          <Field label="First name" autoComplete="off" value={fields.firstName} onChange={set("firstName")} error={errors.firstName ?? null} maxLength={200} />
          <Field label="Last name" autoComplete="off" value={fields.lastName} onChange={set("lastName")} error={errors.lastName ?? null} maxLength={200} />
        </div>
        <Field label="Email address" type="email" autoComplete="off" value={fields.email} onChange={set("email")} error={errors.email ?? null} maxLength={320}
          hint="The address the driver uses in the phone app." />
        <Field label="Payroll or employee reference (optional)" autoComplete="off" value={fields.payrollRef} onChange={set("payrollRef")} maxLength={64} />
        {message === null ? null : <FormMessage tone={message.tone}>{message.text}</FormMessage>}
        <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Adding…" : "Add driver"}</button>
      </form>
    </section>
  );
}

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: "Invited",
  accepted: "Joined",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
};

function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function DriverTable({ invitations, onChanged }: { invitations: DriverInvitation[]; onChanged: () => Promise<void> }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      {problem === null ? null : <p className="drivers__notice" role="alert">{problem}</p>}
      <table className="drivers__table" aria-labelledby="drivers-list-title">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email address</th>
            <th scope="col">Payroll reference</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {invitations.map(invitation => (
            <DriverRow key={invitation.id} invitation={invitation} onChanged={onChanged} onProblem={setProblem} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function DriverRow({ invitation, onChanged, onProblem }: {
  invitation: DriverInvitation;
  onChanged: () => Promise<void>;
  onProblem: (problem: string | null) => void;
}) {
  const { withCompany } = useAuth();
  const [mode, setMode] = useState<"view" | "edit" | "confirm-cancel">("view");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ firstName: invitation.firstName, lastName: invitation.lastName, payrollRef: invitation.payrollRef ?? "" });
  const open = invitation.status === "pending";
  const name = `${invitation.firstName} ${invitation.lastName}`;

  async function settle(result: ApiResult<DriverInvitation>) {
    setBusy(false);
    setMode("view");
    if (result.kind !== "ok") {
      onProblem(result.kind === "refused" && result.code === "INVITATION_NOT_PENDING"
        ? `The invitation for ${name} is no longer open — it was answered, or it expired. Its current status is shown below.`
        : `We could not change the invitation for ${name} just now. Nothing was changed.`);
    } else {
      onProblem(null);
    }
    await onChanged();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || draft.firstName.trim() === "" || draft.lastName.trim() === "") return;
    setBusy(true);
    const payrollRef = draft.payrollRef.trim();
    await settle(await correctInvitation(withCompany, invitation.id, {
      firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), payrollRef: payrollRef === "" ? null : payrollRef,
    }));
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    await settle(await cancelInvitation(withCompany, invitation.id));
  }

  if (mode === "edit") {
    return (
      <tr className="drivers__row" data-status={invitation.status}>
        <td colSpan={5}>
          <form className="drivers__edit" onSubmit={event => void save(event)} noValidate aria-label={`Edit the invitation for ${name}`}>
            <p className="drivers__edit-who">Editing the invitation for {name} ({invitation.email})</p>
            <Field label="Edit first name" value={draft.firstName} maxLength={200} onChange={event => { setDraft(d => ({ ...d, firstName: event.target.value })); }} />
            <Field label="Edit last name" value={draft.lastName} maxLength={200} onChange={event => { setDraft(d => ({ ...d, lastName: event.target.value })); }} />
            <Field label="Edit payroll reference" value={draft.payrollRef} maxLength={64} onChange={event => { setDraft(d => ({ ...d, payrollRef: event.target.value })); }} />
            <p className="drivers__edit-note">The email address cannot be changed. To use another, cancel this invitation and add the driver again.</p>
            <div className="drivers__actions">
              <button className="button button--primary" type="submit" disabled={busy}>Save changes</button>
              <button className="button button--secondary" type="button" onClick={() => { setMode("view"); }}>Keep as it was</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="drivers__row" data-status={invitation.status}>
      <td>{name}</td>
      <td>{invitation.email}</td>
      <td>{invitation.payrollRef ?? ""}</td>
      <td>
        <span className="drivers__status" data-status={invitation.status}>{STATUS_LABEL[invitation.status]}</span>
        {open ? <span className="drivers__status-note">until {dateOf(invitation.expiresAt)}</span> : null}
      </td>
      <td>
        <div className="drivers__actions">
        {open && mode === "view" ? (
          <>
            <button className="button button--secondary" type="button" onClick={() => {
              setDraft({ firstName: invitation.firstName, lastName: invitation.lastName, payrollRef: invitation.payrollRef ?? "" });
              setMode("edit");
            }} aria-label={`Edit ${name}`}>Edit</button>
            <button className="button button--secondary" type="button" onClick={() => { setMode("confirm-cancel"); }} aria-label={`Cancel invitation for ${name}`}>Cancel invitation</button>
          </>
        ) : null}
        {open && mode === "confirm-cancel" ? (
          <>
            <span className="drivers__confirm">Cancel this invitation?</span>
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void cancel()}>Yes, cancel</button>
            <button className="button button--secondary" type="button" onClick={() => { setMode("view"); }}>No</button>
          </>
        ) : null}
        </div>
      </td>
    </tr>
  );
}
