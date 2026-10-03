import { UnitCheckPhone } from "../../components/DriverPhone";
import { SECTION } from "../../paths";

const FEATURES: readonly { title: string; body: string }[] = [
  {
    title: "Large, clear controls",
    body: "Big buttons and answers made for a quick tap — OK, N/A or Defect on every check item.",
  },
  {
    title: "Very little typing",
    body: "Most of the day is taps. Typing is kept for what needs words, like describing a defect.",
  },
  {
    title: "The current shift, first",
    body: "Open the app and the running shift is what you see — its vehicle, its trailer, and the number plate shown large.",
  },
  {
    title: "Straightforward checks",
    body: "Vehicle and trailer checks, laid out section by section.",
  },
  {
    title: "Works without signal",
    body: "The day in progress is kept on the phone. Starting, recording and finishing a shift need no connection.",
  },
  {
    title: "Picks up where you left off",
    body: "Close the app mid-shift, or have the phone close it for you, and the day is still open when you come back.",
  },
];

export function DriverExperience() {
  return (
    <section id={SECTION.features} className="section driver" aria-labelledby="driver-title" tabIndex={-1}>
      <div className="container">
        <div className="driver__header">
          <p className="eyebrow">For drivers</p>
          <h2 id="driver-title" className="driver__heading">
            Made for the cab, <span className="driver__heading-line">not the office desk.</span>
          </h2>
          <p className="driver__intro">
            The driver app is deliberately narrow. It shows the shift that is running and the next thing to do, with
            nothing from the office in the way.
          </p>
        </div>

        {/* The phone is the centrepiece; what it is like to use sits either side of it. */}
        <div className="driver__showcase">
          <div className="driver__visual">
            <UnitCheckPhone />
          </div>
          <ul className="driver__features driver__features--left">
            {FEATURES.slice(0, 3).map(feature => (
              <li key={feature.title} className="feature">
                <h3 className="feature__title">{feature.title}</h3>
                <p className="feature__body">{feature.body}</p>
              </li>
            ))}
          </ul>
          <ul className="driver__features driver__features--right">
            {FEATURES.slice(3).map(feature => (
              <li key={feature.title} className="feature">
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
