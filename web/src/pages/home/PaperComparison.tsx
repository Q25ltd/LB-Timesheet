/**
 * Paper and Timesheets, one topic per row, so each difference reads straight
 * across. On a narrow screen the rows stack and each side names itself; on a
 * wide one the two column headings do that job, so the per-row names are
 * visual on mobile only and always present for a screen reader.
 */
const ROWS: readonly { topic: string; paper: string; timesheets: string }[] = [
  {
    topic: "Times",
    paper: "Written by hand, often at the end of the day.",
    timesheets: "Entered on the phone as the driver declares them, and confirmed when the day is reviewed.",
  },
  {
    topic: "Checks",
    paper: "A separate check sheet for each truck and each trailer.",
    timesheets: "A structured walkaround for every vehicle and trailer used, section by section.",
  },
  {
    topic: "Mileage and fuel",
    paper: "Mileage worked out by hand; fuel noted somewhere else.",
    timesheets: "Start and end mileage with the distance worked out, and fuel and AdBlue on the vehicle they went into.",
  },
  {
    topic: "Defects",
    paper: "Squeezed into the margin of a check sheet.",
    timesheets: "Recorded against the check item it concerns, with a written description.",
  },
  {
    topic: "The finished day",
    paper: "Several sheets to collect, carry and read.",
    timesheets: "One timesheet for the whole day, reviewed and confirmed by the driver.",
  },
];

export function PaperComparison() {
  return (
    <section className="section compare" aria-labelledby="compare-title">
      <div className="container">
        <p className="eyebrow">Paper and Timesheets</p>
        <h2 id="compare-title" className="section-heading">
          From loose sheets to one record of the day.
        </h2>
        <p className="section-intro">
          Paper has worked for years. It just spreads one working day across several forms, in several hands.
        </p>

        <div className="compare__table">
          <div className="compare__head" aria-hidden="true">
            <span />
            <span className="compare__head-paper">On paper</span>
            <span className="compare__head-app">With Timesheets</span>
          </div>
          {ROWS.map(row => (
            <div key={row.topic} className="compare__row">
              <h3 className="compare__topic">{row.topic}</h3>
              <p className="compare__cell compare__cell--paper">
                <span className="compare__side">On paper</span>
                {row.paper}
              </p>
              <p className="compare__cell compare__cell--app">
                <span className="compare__side">With Timesheets</span>
                {row.timesheets}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
