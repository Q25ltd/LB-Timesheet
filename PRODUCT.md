# LogisticBay Timesheets — Product

> Authoritative product definition and scope. [STATUS.md](STATUS.md) owns what
> is actually built; [DECISIONS.md](DECISIONS.md) owns settled and open decisions.
> Updated 2026-10-17: owner-approved expanded direction, recorded in D67.

## Goal

Help haulage and transport companies in any country replace paper daily
records and coordinate simple planned work through a driver phone app and a
company website. Keep the product simple, inexpensive to operate and useful
without adopting the separate LogisticBay TMS.

The core remains **paper form → phone → PDF → company email**. The approved
scope also includes simple company-created Jobs, Unit and Trailer registers,
assignments, advance Planning, driver availability, damage/VOR visibility,
notifications, safety reminders and How to Use instructions (D67).

Approval of product scope is not evidence of implementation. See STATUS.md.
**D66 remains the immediate development priority.** Whether the first public
release includes only Core Timesheets or also expanded features remains an
owner decision (O12). This document does not silently defer or accelerate them.

## Product boundary

Included in the approved direction:

- Daily timesheets, declared start/finish times and night out.
- Vehicle and trailer uses, changes, walkaround checks, written defects,
  corrections, fuel, AdBlue / DEF and fridge diesel.
- Driver review and declaration, immutable submissions and amendments,
  company review, reproducible PDF reports and reliable email delivery (D66).
- Separate driver/company accounts, multi-company memberships and a private
  personal driver diary, with the diary's release scope still open.
- Simple Jobs and advance Planning, driver/unit/trailer assignments, weekly
  shift patterns, availability and manual holiday/sickness marking.
- Unit and Trailer registers, reservations, loaded/empty trailer reports,
  damage and VOR indicators, and prominent company-dashboard VOR warnings.
- Reliable operational synchronization, notifications, a once-per-new-shift
  safety reminder and How to Use instructions.

Still outside the approved scope: GPS or live driver tracking, route
optimization, invoicing, payroll processing, CRM, full customer/load-management
systems, workshop/parts management, PMI scheduling, maintenance planning and
fleet-utilization analytics. Simple collection/delivery Jobs, asset assignments,
Planning and VOR visibility are included; their former blanket exclusion is
superseded by D67. Do not infer permission for a full TMS from that change.

Timesheets and the TMS remain separate products: separate repository, API,
database, accounts, secrets, sessions, migrations, billing and deployment.
Shared branding does not mean shared code or data (D1–D6).

## Accounts and company setup

A driver registers on the phone with first name, last name, email and password.
A driver can have zero, one or multiple company memberships. Personal records
require no invented company or membership. A company registers separately on
the website; a matching driver/company email never links the two accounts (D51).

The company chooses its operational IANA timezone and its distance and volume
units. It confirms its account email, sets and verifies the report inbox, and
invites drivers by email. Drivers verify their own email and explicitly accept,
decline or leave invitations unanswered (D63). Permanent joining codes are not
the onboarding mechanism. Driver removal is soft and preserves records (D65).

Configurable checks and subscriptions are part of unresolved product/release
planning, not prerequisites to invent in the onboarding flow (O7, O16).

## Driver experience and planned suggestions

Keep mandatory interaction to a minimum. No mandatory driving, working, break
or POA activity switching; no GPS or background driver monitoring.

- Morning: open, choose Personal or a company destination, confirm the start
  and optionally record a vehicle. Personal remains the default (D28–D29).
- During work: interact when recording a check, fill, asset change or an
  assigned job's relevant update/completion; no continuous activity tracking.
- Finish: enter finish details, review/correct, declare, then save a Personal
  day or explicitly queue the company's timesheet for sending (D38–D42, D66).

An existing company plan offers relevant **optional suggestions**: unit,
trailer, date, start time and assignment details. The driver can accept, change
or ignore them and can start without any plan. A plan never automatically
starts a shift, overwrites actual asset details, changes declared working times
or rewrites a completed timesheet. Actual driver records take precedence.

**Job/reference numbers require fresh entry or explicit confirmation for the
current job.** Never silently carry one forward from an earlier job or plan.
Planned hours and actual timesheet hours remain separate facts.

## Simple Jobs

The initial Jobs workflow is **company creates → driver receives → driver
completes**. A job supports collection/delivery, a reference, optional address
and instructions, driver assignment, intended unit/trailer, a future date and
optional planned start time. Support updates, cancellations, notifications,
multiple jobs per driver per shift and completion reporting.

Duplicate references and assignment conflicts produce warnings, not automatic
rejection. Job instructions and completion records do not silently mutate the
D66 timesheet or its PDF snapshot. Including job data in a report would require
an explicit later decision; D66's approved report contents remain unchanged.

**Driver-created jobs are deferred pending real-world pilot feedback.** They
are not an initial Jobs implementation requirement and are not rejected
permanently. Reconsider only when testing demonstrates the need, then decide
the scope and authority before implementing. Draft → Send to Driver remains
an open workflow decision (O13).

## Units, Trailers and company dashboard

A Unit or Trailer register requires only a registration/identification number;
do not invent mandatory master-data fields. Distinguish the **Unit register**
(vehicle assets) from **measurement units** (D52/D66).

Provide simple asset lists, latest reported driver/use, damage and VOR
indicators, trailer reservations for specific unit registrations, loaded/empty
trailer reporting and warnings about conflicting reservations. Latest reported
use is a report, not a claim of live location or device state. Planned
assignments never replace actual asset-use history.

When a company administrator signs in, active VOR warnings are prominently
visible on the **main dashboard**, with the affected registration/identifier
and access to its defect report. They must not be hidden only in asset pages.
Warnings remain active until explicitly cleared by an authorized actor;
clearance permissions and evidence are still open (O14). No automatic clearance
from a later good check, job completion or synchronization.

An offline defect/VOR report must not appear as already received by the office.
This simple visibility feature does not introduce workshop, repair, parts or
maintenance-management workflows.

## Planning and driver availability

Support advance jobs/assignments, weekly shift patterns, planned start times,
days off, manual holiday marking and manual sickness marking. Assigning an
unavailable driver produces a warning; plans remain distinguishable from actual
work. Driver holiday requests and company approval/decline are later features,
not requirements of the initial manual-marking workflow.

## Safety and How to Use

Show the agreed safety reminder once per **new shift**, available offline and
requiring only one dismissal for that shift. It must tell the driver to phone
the office directly about serious defects, VOR, accidents, major delays and
urgent operational issues. Synchronization and notifications do not replace
that direct call or prove the office has seen an urgent report.

Provide How to Use instructions for the relevant driver and company workflows.
Guidance must accurately distinguish local saves, server receipt, delivery and
acknowledgement; it must not promise unbuilt or guaranteed background behaviour.

## Actual times, assets and checks

Start/finish times are the driver's declared business data. Preserve the
confirmed instant; never clamp or round it to the device or server clock.
D20 defines start-time confirmation; D40 refines finish-time confirmation
(strictly more than 15 minutes ahead asks once, never rejects solely for being
in the future). Chronology constraints still apply. One shift crossing midnight
remains one timesheet, dated by its declared start in the company timezone (D18).

Each period of vehicle or trailer use has a stable identity independent of
its registration and correctable times. Returning to the same asset is a new
use. A shift can start or continue without a vehicle; no activity or placeholder
asset is invented for the gap. Trailers have their own uses beside vehicle uses.
Existing use details and trailer types remain as decided in D30–D35; a minimal
asset register does not remove information needed by actual checks or fills.

Checks are attached to the exact asset use. Draft defaults are not certified
checks. Completed checks are immutable certificates corrected by appended
revisions. Written defects retain their asset, item, driver and completion/
correction context. No photographs in V1 (D10). General checklists are not a
claim of approval by a national regulator.

Fuel/AdBlue belongs to the exact vehicle use; fridge diesel belongs to the
refrigerated trailer use. Unknown quantity is not zero. Values retain their
recorded measurement units, with no conversion/relabeling of history. Historical
odometer units stay unknown; historical litres retain their provenance (D66).

## Offline storage, submission and operational synchronization

The working day is local first. Account-isolated storage, restart recovery,
explicit interrupted-save recovery and preservation of unsent records remain
required (D28, D37, D60–D62). A plan or notification must never become a new
way to bypass authentication or obtain another account's local records.

**D66 submission is its own boundary:** persistent receipts/submissions,
idempotent retry, immutable revision snapshots, company review and authoritative
revisions, delivery jobs and PDF/email. A company timesheet locks once queued;
post-submission correction is an amendment. Personal days are never submitted.
Active membership or qualifying server start evidence verifies a submission;
otherwise it waits for company review. Device clocks and plans are not evidence
of eligibility. Foreground/reconnect retries do not promise background sending.

**Operational synchronization is separate from the D66 submission queue.**
Jobs, plans, assignments and operational reports must survive lost connectivity
and app restart, preserve account/company isolation and retain conflicts rather
than silently overwrite actual records. Show the last synchronization time,
not an invented live/online status. Distinguish server receipt, device delivery
and explicit acknowledgement. Notifications may prompt synchronization, but
push delivery is not guaranteed. New endpoints, storage, permission and conflict
rules need their own approved implementation boundaries and security evidence;
D67 does not grant blanket tenant access or redesign AUTH.md.

## Company PDF and delivery — D66 remains intact

The A4 PDF contains company and driver names, payroll reference when configured,
date, declared start/finish and elapsed duration; every actual vehicle/trailer
use and change time; recorded odometer readings/distance and units; checks,
drafts clearly marked uncertified, corrections/history and defects; fuel,
AdBlue / DEF and fridge diesel; night out, company-facing finish notes,
declaration, submission reference/revision and applicable review status.

Never include the driver's email, private diary, other employers or unapproved
job/planning data. Label company-facing notes before entry. Submitted snapshots
are immutable; a pending amendment never displaces the authoritative accepted
revision until accepted. Review reasons and decisions are retained (D66).

Regenerate PDFs from stored snapshots and versioned templates; do not store PDF
files. Preserve international text and investigate shaping, RTL and CJK before
finalizing rendering. Accepted revisions enqueue delivery transactionally;
workers claim safely, retry with backoff and expose failure/admin retry. No
report is sent to an unverified address or for a pending-review revision. Rare
duplicate emails after an ambiguous SES response are accepted and identifiable
by reference/revision. Email success never determines whether a timesheet exists.

## Private personal features

The optional personal diary may contain driving, other work, POA, rest/break,
distance, rates, allowances and estimated earnings/history across employers.
It is private to the driver and never enters company screens, operational sync,
exports or PDFs without explicit separate authorization. Personal records do
not become company data merely because a job or plan exists. Diary enhancements
are later work; first-release diary scope and portability remain open (O3–O4,
O18). No mandatory activity switching or payroll processing is implied.

## Billing, retention and release decisions

Companies pay; drivers do not buy access to submit their employer's records.
Pricing/subscription enforcement is undecided (O7). Submitted records are kept
(D9), but retention duration, cancellation and export/deletion policies need an
owner decision (O1); do not introduce automatic purges.

Q25 Ltd's existing data-role and privacy decisions remain in force (D11).
Keep Core Timesheets and the expanded operational scope distinguishable when
planning a release. The open-decision register in DECISIONS.md owns release
scope, job sending, VOR clearance, configurable checks, additional administrators
and private diary choices. STATUS.md alone records implementation progress.
