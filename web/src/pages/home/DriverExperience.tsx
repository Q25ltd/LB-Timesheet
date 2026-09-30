import { UnitCheckPhone } from "../../components/DriverPhone";
import { Icon, type IconName } from "../../components/Icon";
import { SECTION } from "../../paths";

const FEATURES: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: "tap",
    title: "Large, clear controls",
    body: "Big buttons and answers made for a quick tap — OK, N/A or Defect on every check item.",
  },
  {
    icon: "keyboard",
    title: "Very little typing",
    body: "Most of the day is taps. Typing is kept for what needs words, like describing a defect.",
  },
  {
    icon: "truck",
    title: "The current shift, first",
    body: "Open the app and the running shift is what you see — its vehicle, its trailer, and the number plate shown large.",
  },
  {
    icon: "clipboard",
    title: "Straightforward checks",
    body: "Vehicle and trailer checks, laid out section by section.",
  },
  {
    icon: "noSignal",
    title: "Works without signal",
    body: "The day in progress is kept on the phone. Starting, recording and finishing a shift need no connection.",
  },
  {
    icon: "restore",
    title: "Picks up where you left off",
    body: "Close the app mid-shift, or have the phone close it for you, and the day is still open when you come back.",
  },
];

export function DriverExperience() {
  return (
    <section id={SECTION.features} className="section section--tinted driver" aria-labelledby="driver-title" tabIndex={-1}>
      <div className="container driver__inner">
        <div className="driver__visual">
          <UnitCheckPhone />
        </div>
        <div className="driver__copy">
          <p className="eyebrow">For drivers</p>
          <h2 id="driver-title" className="section-heading">
            Made for the cab, not the office desk.
          </h2>
          <p className="section-intro">
            The driver app is deliberately narrow. It shows the shift that is running and the next thing to do, with
            nothing from the office in the way.
          </p>
          <ul className="driver__features">
            {FEATURES.map(feature => (
              <li key={feature.title} className="feature">
                <Icon name={feature.icon} className="feature__icon" />
                <h3 className="feature__title">{feature.title}</h3>
                <p className="feature__body">{feature.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
