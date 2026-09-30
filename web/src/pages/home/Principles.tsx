import { Icon, type IconName } from "../../components/Icon";

const PRINCIPLES: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: "tap",
    title: "Simple for drivers",
    body: "Built around the shift in progress — what is running, on which vehicle, and what still needs doing. No office software to learn.",
  },
  {
    icon: "records",
    title: "Clear records",
    body: "Times, vehicles, checks, mileage, fuel and defects kept together in one record of the day, not spread across separate sheets.",
  },
  {
    icon: "noSignal",
    title: "Built for real working days",
    body: "The day in progress is kept on the phone. Poor signal does not stop a driver recording it, and closing the app does not lose it.",
  },
];

export function Principles() {
  return (
    <section className="section principles" aria-labelledby="principles-title">
      <div className="container">
        <h2 id="principles-title" className="principles__statement">
          Built for the working day — not for adding more admin.
        </h2>
        <ul className="principles__list">
          {PRINCIPLES.map(principle => (
            <li key={principle.title} className="principle">
              <span className="principle__icon">
                <Icon name={principle.icon} />
              </span>
              <h3 className="principle__title">{principle.title}</h3>
              <p className="principle__body">{principle.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
