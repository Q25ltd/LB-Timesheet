import type { ReactNode } from "react";
import { Icon } from "./Icon";
import "../styles/phone.css";

/**
 * A picture of the driver app, drawn in HTML so it stays sharp at any size
 * and costs no image download.
 *
 * It is a marketing picture, not the app: nothing in it is interactive, and
 * it is announced as ONE image with a description (`role="img"` plus
 * `aria-label`), its contents hidden from assistive technology so nobody is
 * offered buttons that do nothing. Its labels are the real app's own wording
 * (`mobile/src/screens/ActiveShiftScreen.tsx`, `VehicleCheckScreen.tsx`,
 * `mobile/src/shift/checklists.ts`), so it shows what the app does and
 * nothing it does not — with one owner-chosen exception: the app's "Working
 * for" fact reads "Company" here, beside a fictional "Example Haulage".
 */
function PhoneFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    // `.phone` is the size container; everything inside is sized from its
    // width, so the picture scales as one object instead of reflowing.
    <div className="phone" role="img" aria-label={label}>
      <div className="phone__device">
        <div className="phone__screen" aria-hidden="true">
          <div className="phone__status-bar">
            <span>07:42</span>
            <span className="phone__island" />
            <span className="phone__status-icons">
              <span className="phone__signal" />
              <span className="phone__battery" />
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ActiveShiftPhone() {
  return (
    <PhoneFrame label="The Timesheets driver app on a phone, showing an active shift started at 06:00: unit AB12 CDE, Class 1, with its vehicle checks completed, fuel and AdBlue recorded, trailer C827 checked, and a Finish Shift button.">
      <div className="app">
        <div className="app__titlebar">
          <span className="app__title">Active Shift</span>
          <span className="app__quiet">Discard</span>
        </div>

        <div className="app__status">
          <div className="app__status-head">
            <span className="app__status-icon">
              <Icon name="clock" />
            </span>
            Shift active
          </div>
          <div className="app__facts">
            <span className="app__fact">
              <span className="app__fact-label">Started</span>
              <span className="app__fact-value">06:00</span>
            </span>
            <span className="app__fact">
              <span className="app__fact-label">Company</span>
              <span className="app__fact-value">Example Haulage</span>
            </span>
          </div>
        </div>

        <span className="app__section-label">Current unit</span>
        <div className="app__card">
          <div className="app__plate-panel">
            <span className="app__plate">AB12 CDE</span>
            <span className="app__class">Class 1</span>
          </div>
          <div className="app__row">
            <span>Start mileage</span>
            <span className="app__row-value">100,000 mi</span>
          </div>
          <div className="app__row">
            <span>Vehicle checks</span>
            <span className="app__row-value app__row-value--ok">
              <Icon name="check" />
              Completed
            </span>
          </div>
          <div className="app__buttons">
            <span className="app__button">Vehicle Checks</span>
            <span className="app__button">Change Unit</span>
          </div>
          <div className="app__tiles">
            <span className="app__tile">
              <span className="app__tile-label">Fuel</span>
              <span className="app__tile-amount">180 L</span>
              <span className="app__tile-detail">1 entry</span>
            </span>
            <span className="app__tile">
              <span className="app__tile-label">AdBlue</span>
              <span className="app__tile-amount">20 L</span>
              <span className="app__tile-detail">1 entry</span>
            </span>
          </div>
        </div>

        <span className="app__section-label">Current trailer</span>
        <div className="app__card app__card--folded">
          <span className="app__plate app__plate--small">C827</span>
          <span className="app__folded-state">Checks completed</span>
          <Icon name="chevron" className="app__folded-chevron" />
        </div>
      </div>
      <div className="app__footer">
        <span className="app__primary">Finish Shift</span>
      </div>
    </PhoneFrame>
  );
}

const CHOICES = ["OK", "N/A", "DEFECT"] as const;
type Choice = (typeof CHOICES)[number];

function CheckRow({ label, answer, defect }: { label: string; answer: Choice; defect?: string }) {
  return (
    <div className="check-row">
      <span className="check-row__label">{label}</span>
      <span className="check-row__choices">
        {CHOICES.map(choice => (
          <span key={choice} className="check-row__choice" data-choice={choice} data-selected={choice === answer}>
            {choice}
          </span>
        ))}
      </span>
      {defect === undefined ? null : <span className="check-row__defect">{defect}</span>}
    </div>
  );
}

export function UnitCheckPhone() {
  return (
    <PhoneFrame label="The Timesheets driver app on a phone, showing a unit walkaround check in progress for AB12 CDE: each item answered OK, N/A or Defect with one tap, and one defect described in the driver's own words.">
      <div className="app">
        <div className="app__titlebar">
          <span className="app__back">
            <Icon name="chevron" className="app__back-icon" />
            Back to shift
          </span>
        </div>
        <div className="app__check-head">
          <span className="app__title">Unit Check</span>
          <span className="app__check-meta">AB12 CDE · Class 1 · In progress</span>
        </div>

        <span className="app__section-label">Brakes</span>
        <div className="app__card app__card--list">
          <CheckRow label="Air build-up & warning" answer="OK" />
          <CheckRow label="Air leaks" answer="OK" />
          <CheckRow label="Service brake & pedal" answer="DEFECT" defect="Pedal travel longer than normal" />
        </div>

        <span className="app__section-label">Lights / electrical</span>
        <div className="app__card app__card--list">
          <CheckRow label="Lights & lenses" answer="OK" />
          <CheckRow label="Indicators" answer="OK" />
        </div>
      </div>
      <div className="app__footer">
        <span className="app__primary">Complete Check</span>
      </div>
    </PhoneFrame>
  );
}
