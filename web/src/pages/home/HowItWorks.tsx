import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { SECTION } from "../../paths";

/**
 * The day in three stages, told along the day's own timeline. Each stage
 * carries a small example of what the driver sees at that point; the example
 * is illustration, so it is hidden from assistive technology and the stage's
 * text says everything it shows.
 */
function Snippet({ children }: { children: ReactNode }) {
  return (
    <div className="snippet" aria-hidden="true">
      {children}
    </div>
  );
}

function SnippetRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="snippet__row">
      <span className="snippet__label">{label}</span>
      <span className="snippet__value">{value}</span>
    </span>
  );
}

function SnippetEvent({ icon, label, value, tone }: { icon: IconName; label: string; value: string; tone?: "ok" | "defect" }) {
  return (
    <span className="snippet__event" data-tone={tone}>
      <Icon name={icon} className="snippet__event-icon" />
      <span className="snippet__event-label">{label}</span>
      <span className="snippet__event-value">{value}</span>
    </span>
  );
}

export function HowItWorks() {
  return (
    <section id={SECTION.howItWorks} className="section section--tinted how" aria-labelledby="how-title" tabIndex={-1}>
      <div className="container">
        <p className="eyebrow">How it works</p>
        <h2 id="how-title" className="section-heading">
          One record of the day, from booking on to finishing.
        </h2>

        <ol className="how__steps">
          <li className="how__step">
            <span className="how__marker">
              <span className="how__number">1</span>
              <span className="how__time">06:00</span>
            </span>
            <h3 className="how__title">Start your shift</h3>
            <p className="how__body">
              Enter the start time. If you have a vehicle, add its class, number plate and start mileage — or start
              without one and add it when it arrives.
            </p>
            <Snippet>
              <span className="snippet__title">Start Shift</span>
              <SnippetRow label="Start time" value="06:00" />
              <SnippetRow label="Vehicle" value="Class 1" />
              <SnippetRow label="Number plate" value="AB12 CDE" />
              <SnippetRow label="Start mileage" value="100,000" />
            </Snippet>
          </li>

          <li className="how__step">
            <span className="how__marker">
              <span className="how__number">2</span>
              <span className="how__time">Through the day</span>
            </span>
            <h3 className="how__title">Record the day</h3>
            <p className="how__body">
              Walkaround checks for each vehicle and trailer, changes of unit or trailer, fuel and AdBlue, and any
              defect with a written description — each recorded when it happens.
            </p>
            <Snippet>
              <SnippetEvent icon="checkCircle" label="Unit check completed" value="AB12 CDE" tone="ok" />
              <SnippetEvent icon="swap" label="Trailer changed" value="C123 → C827" />
              <SnippetEvent icon="fuel" label="Fuel" value="180 L" />
              <SnippetEvent icon="drop" label="AdBlue" value="20 L" />
              <SnippetEvent icon="alert" label="Defect" value="Service brake & pedal" tone="defect" />
            </Snippet>
          </li>

          <li className="how__step">
            <span className="how__marker">
              <span className="how__number">3</span>
              <span className="how__time">16:30</span>
            </span>
            <h3 className="how__title">Finish and review</h3>
            <p className="how__body">
              Enter the finish time and final mileage, then review the whole day on one screen, confirm the details
              and save the completed timesheet.
            </p>
            <Snippet>
              <span className="snippet__title">Review</span>
              <SnippetRow label="Started" value="06:00" />
              <SnippetRow label="Finished" value="16:30" />
              <SnippetRow label="Duration" value="10 h 30 min" />
              <span className="snippet__confirm">
                <span className="snippet__checkbox">
                  <Icon name="check" />
                </span>
                I confirm all details are correct
              </span>
              <span className="snippet__button">Save Timesheet</span>
            </Snippet>
          </li>
        </ol>
      </div>
    </section>
  );
}
