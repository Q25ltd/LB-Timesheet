import { Icon } from "../../components/Icon";
import { SECTION } from "../../paths";

/**
 * What companies will get — and it says, first, that it does not exist yet.
 *
 * Everything about sending a timesheet to a company, company accounts and
 * submitted records is PLANNED (STATUS.md), so it lives only inside this
 * `data-status="planned"` region, which must say plainly that it is not
 * available yet. The homepage tests hold both rules: delivery language
 * appears nowhere else on the page, and this region states its status.
 * No dashboard is pictured, because none exists.
 */
const PLANNED = [
  "A company account, with settings that include where your timesheets are delivered.",
  "Access for your drivers, managed by your company.",
  "Each submitted timesheet kept, so a copy can be downloaded again if the original is lost.",
] as const;

export function ForCompanies() {
  return (
    <section id={SECTION.forCompanies} className="section companies" aria-labelledby="companies-title" tabIndex={-1}>
      <div className="container">
        <div className="companies__panel" data-status="planned">
          <div className="companies__copy">
            <p className="companies__status">
              <span className="companies__status-dot" aria-hidden="true" />
              In development — not available yet
            </p>
            <h2 id="companies-title" className="section-heading">
              For companies: a clearer record of every submitted shift.
            </h2>
            <p className="section-intro">
              Timesheets is being built so a driver can send the reviewed timesheet to the company they worked for.
              Company accounts are the next stage of development and are not open yet.
            </p>
            <p className="companies__focus">
              A company will receive the timesheet itself — times, vehicles, checks, defects and the driver’s
              declaration. Not where a driver has been, and not who else they drive for.
            </p>
          </div>
          <div className="companies__planned">
            <h3 className="companies__planned-title">Planned for company accounts</h3>
            <ul className="companies__list">
              {PLANNED.map(item => (
                <li key={item}>
                  <Icon name="arrowRight" className="companies__bullet" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
