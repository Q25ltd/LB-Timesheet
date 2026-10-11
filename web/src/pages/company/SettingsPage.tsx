import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import type { ApiResult } from "../../auth/http";
import { FormMessage, SelectField } from "../../components/Field";
import { DISTANCE_UNITS, VOLUME_UNITS, isDistanceUnit, isVolumeUnit } from "../../units";
import { usePageTitle } from "../../usePageTitle";
import { readUnits, saveUnits, unitsMissing, type CompanyUnits } from "./companySettingsApi";

/**
 * SETTINGS — the company's configuration (`/company/settings`, D66).
 *
 * Measurement units: what the company's drivers record odometer readings and
 * fuel in. A company registered before units existed has none and is asked to
 * choose; nothing is preselected for it. Changing them affects what is
 * recorded from then on — every reading already recorded keeps the unit it
 * was recorded in, and nothing is converted.
 */
export function SettingsPage() {
  usePageTitle("Settings");
  const { withCompany } = useAuth();
  const [units, setUnits] = useState<CompanyUnits | "loading" | "failed" | "forbidden">("loading");

  const load = useCallback(async () => {
    const result = await readUnits(withCompany);
    if (result.kind === "ok") setUnits(result.value);
    else setUnits(result.kind === "refused" && result.status === 403 ? "forbidden" : "failed");
  }, [withCompany]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="settings">
      <header className="settings__head">
        <h1 className="settings__title">Settings</h1>
        <p className="settings__intro">How your company&apos;s timesheets are recorded.</p>
      </header>

      {units === "forbidden" ? (
        <p className="settings__notice" role="alert">Your account is not allowed to change this company&apos;s settings.</p>
      ) : (
        <section className="settings__section" aria-labelledby="units-title">
          <h2 id="units-title" className="company-section-title">Measurement units</h2>
          <p className="settings__text">
            The units your drivers record odometer readings and fuel in. A change applies to what is recorded from then on;
            every reading already recorded keeps the unit it was recorded in, and nothing is converted.
          </p>
          {units === "loading" ? <p className="settings__notice" role="status">Loading your settings…</p> : null}
          {units === "failed" ? (
            <p className="settings__notice" role="alert">
              We could not load your settings just now. Nothing has changed — try again in a moment.
              {" "}<button className="button button--secondary" type="button" onClick={() => void load()}>Try again</button>
            </p>
          ) : null}
          {typeof units === "object" ? <UnitsForm units={units} onSaved={setUnits} /> : null}
        </section>
      )}
    </div>
  );
}

function refusal(result: Exclude<ApiResult<unknown>, { kind: "ok" }>): string {
  if (result.kind === "refused" && result.status === 403) return "Your account is not allowed to change this company's settings.";
  if (result.kind === "refused" && result.status === 400) return "Choose both units and try again.";
  return "We could not save your units just now. Nothing was changed — try again in a moment.";
}

function UnitsForm({ units, onSaved }: { units: CompanyUnits; onSaved: (units: CompanyUnits) => void }) {
  const { withCompany } = useAuth();
  const [distance, setDistance] = useState<string>(units.distanceUnit ?? "");
  const [volume, setVolume] = useState<string>(units.volumeUnit ?? "");
  const [problems, setProblems] = useState<{ distance?: string; volume?: string }>({});
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found: { distance?: string; volume?: string } = {};
    if (!isDistanceUnit(distance)) found.distance = "Choose the unit your vehicles' odometers show";
    if (!isVolumeUnit(volume)) found.volume = "Choose the unit fuel is recorded in";
    setProblems(found);
    setMessage(null);
    if (!isDistanceUnit(distance) || !isVolumeUnit(volume)) return;
    setBusy(true);
    const result = await saveUnits(withCompany, { distanceUnit: distance, volumeUnit: volume });
    setBusy(false);
    if (result.kind !== "ok") {
      setMessage({ tone: "error", text: refusal(result) });
      return;
    }
    onSaved(result.value);
    setMessage({ tone: "success", text: "Units saved. What your drivers record from now on uses them; earlier records keep their own units." });
  }

  return (
    <form className="auth-form settings__form" onSubmit={event => void submit(event)} noValidate>
      {unitsMissing(units) ? (
        <p className="settings__prompt" role="status">Your company has not chosen its units yet. Choose them so your drivers&apos; readings say what they mean.</p>
      ) : null}
      <div className="settings__row">
        <SelectField label="Distance unit" name="distanceUnit" autoComplete="off" required hint="What your vehicles' odometers show."
          value={distance} error={problems.distance ?? null} onChange={event => { setDistance(event.target.value); }}>
          <option value="" disabled>Choose a unit</option>
          {DISTANCE_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
        </SelectField>
        <SelectField label="Fuel unit" name="volumeUnit" autoComplete="off" required hint="The unit fuel and AdBlue / DEF quantities are recorded in."
          value={volume} error={problems.volume ?? null} onChange={event => { setVolume(event.target.value); }}>
          <option value="" disabled>Choose a unit</option>
          {VOLUME_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
        </SelectField>
      </div>
      {message === null ? null : <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save units"}</button>
    </form>
  );
}
