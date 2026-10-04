import { useAuth } from "../../auth/AuthProvider";
import { Icon } from "../../components/Icon";
import { usePageTitle } from "../../usePageTitle";

/**
 * HOME — the company workspace's first page (`/company`).
 *
 * It shows only what is real: the company the server confirmed, and the one
 * thing that has happened — the company exists. Everything after that (drivers,
 * the phone-app connection, submitted timesheets) is not built, and is said to
 * be not available rather than drawn as if it worked: no counts, no charts,
 * nothing to press.
 *
 * Three parts, each its own section so Home can change without being thrown
 * away: who this is (`CompanyIdentity`), what happens next
 * (`GettingStarted` — today's whole story, for a company with no drivers and no
 * timesheets; when real activity exists it is replaced by that activity, at
 * this route, in this frame), and what the workspace holds (`WorkspaceGuide`).
 */
export function CompanyHome() {
  const auth = useAuth();
  const company = auth.state.status === "signed-in" ? auth.state.company : null;
  const companyName = company?.membership.companyName ?? "";
  usePageTitle(companyName === "" ? "Company" : companyName);
  if (company === null) return null;

  return (
    <div className="company-home">
      <CompanyIdentity companyName={companyName} />
      <div className="company-home__body">
        <GettingStarted companyName={companyName} />
        <WorkspaceGuide />
      </div>
    </div>
  );
}

function CompanyIdentity({ companyName }: { companyName: string }) {
  return (
    <section className="company-identity" aria-labelledby="company-name">
      <div className="company-identity__inner">
        <div>
          <p className="company-identity__eyebrow">Company workspace</p>
          <h1 id="company-name" className="company-identity__name">{companyName}</h1>
        </div>
        <p className="company-identity__purpose">
          This is where your company will receive the daily timesheets and vehicle checks your drivers
          submit from the LogisticBay Timesheets phone app.
        </p>
      </div>
    </section>
  );
}

type StepState = "done" | "unavailable";

interface Step {
  title: string;
  state: StepState;
  detail: (companyName: string) => string;
}

/**
 * The approved path to a company's first timesheet. Only the first step can
 * be done today; the others are named for what they will be, and say they
 * are not available. How a driver connects is NOT described: it is not
 * designed yet.
 */
const STEPS: readonly Step[] = [
  {
    title: "Company created",
    state: "done",
    detail: name => `${name} is registered, and its administrator's email address is confirmed.`,
  },
  {
    title: "Add your first driver",
    state: "unavailable",
    detail: () => "Adding drivers to your company is being built. It will happen under Drivers.",
  },
  {
    title: "Your driver connects with the phone app",
    state: "unavailable",
    detail: () => "Drivers fill in their day on the LogisticBay Timesheets phone app. How a driver connects to your company is still being designed.",
  },
  {
    title: "Receive your first timesheet",
    state: "unavailable",
    detail: () => "Timesheets your drivers submit will arrive under Timesheets.",
  },
];

function GettingStarted({ companyName }: { companyName: string }) {
  // The first step not yet done is the NEXT one — marked, though not available.
  const next = STEPS.findIndex(step => step.state !== "done");
  return (
    <section className="getting-started" aria-labelledby="getting-started-title">
      <div className="getting-started__head">
        <h2 id="getting-started-title" className="company-section-title">Getting started</h2>
        <p className="getting-started__intro">
          The path from registering to your first timesheet. Your company is set up; the steps after it are still being built.
        </p>
      </div>
      <ol className="steps">
        {STEPS.map((step, index) => (
          <li key={step.title} className="step" data-state={step.state} data-next={index === next ? "true" : undefined}>
            <span className="step__marker" aria-hidden="true">
              {step.state === "done" ? <Icon name="check" className="step__check" /> : null}
            </span>
            <div className="step__body">
              <h3 className="step__title">{step.title}</h3>
              <p className="step__status">
                {step.state === "done" ? "Done" : index === next ? "Next step · Not available yet" : "Not available yet"}
              </p>
              <p className="step__detail">{step.detail(companyName)}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const AREAS = [
  { name: "Home", summary: "This page: where your company stands, and what needs attention.", available: true },
  { name: "Drivers", summary: "The drivers connected to your company.", available: false },
  { name: "Timesheets", summary: "The timesheets and vehicle checks your drivers submit to your company.", available: false },
  { name: "Settings", summary: "Your company's details and configuration.", available: false },
] as const;

function WorkspaceGuide() {
  return (
    <section className="workspace-guide" aria-labelledby="workspace-guide-title">
      <h2 id="workspace-guide-title" className="company-section-title">Your workspace</h2>
      <ul className="workspace-guide__list">
        {AREAS.map(area => (
          <li key={area.name} className="workspace-guide__item" data-available={area.available}>
            <h3 className="workspace-guide__name">{area.name}</h3>
            <p className="workspace-guide__summary">{area.summary}</p>
            <p className="workspace-guide__state">{area.available ? "You are here" : "Not available yet"}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
