import { Link } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PATHS } from "../../paths";
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

type StepState = "done" | "available" | "unavailable";

interface Step {
  title: string;
  state: StepState;
  detail: (companyName: string) => string;
}

/**
 * The approved path to a company's first timesheet. The first step is done;
 * adding drivers is available under Drivers (D63, stage 4) — Home asks the
 * server nothing about drivers, so it cannot say whether that is done, only
 * where to do it. The steps after it say they are not available yet.
 */
const STEPS: readonly Step[] = [
  {
    title: "Company created",
    state: "done",
    detail: name => `${name} is registered, and its administrator's email address is confirmed.`,
  },
  {
    title: "Add your first driver",
    state: "available",
    detail: () => "Under Drivers, add each driver's name and the email address they use in the phone app. Each one gets an invitation.",
  },
  {
    title: "Your driver connects with the phone app",
    state: "unavailable",
    detail: () => "The driver confirms their email address in the LogisticBay Timesheets phone app and accepts your invitation there. Accepting in the app is still being built.",
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
                {step.state === "done" ? "Done" : step.state === "available" ? "Next step" : index === next ? "Next step · Not available yet" : "Not available yet"}
              </p>
              <p className="step__detail">{step.detail(companyName)}</p>
              {step.state === "available" ? <Link className="step__link" to={PATHS.companyDrivers}>Go to Drivers</Link> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const AREAS = [
  { name: "Home", summary: "This page: where your company stands, and what needs attention.", available: true },
  { name: "Drivers", summary: "Add your drivers and see who has joined.", available: true },
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
            <p className="workspace-guide__state">{area.name === "Home" ? "You are here" : area.available ? "Available" : "Not available yet"}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
