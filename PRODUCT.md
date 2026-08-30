# LogisticBay Timesheets — Product

> What this product is and where its edges are.
> For what is actually built, see **STATUS.md**. For settled/open decisions, see **DECISIONS.md**.
> Last updated: 2026-08-25

---

## Goal

Replace the paper daily timesheet and the paper daily vehicle/trailer check sheet
used by UK HGV drivers with a simple mobile app.

**Paper form → phone → PDF → company email.**

Deliberately simple, cheap to operate, easy for a small haulage company to adopt.

## Boundary

**In scope**

1. Driver daily timesheets
2. Start and finish times
3. Daily truck checks
4. Daily trailer checks
5. Defect reporting
6. Truck/trailer changes during a shift
7. Checks required after an asset change
8. Driver declaration / signature
9. PDF generation
10. Automatic email delivery to the company
11. Optional **private** personal statistics for the driver

**Out of scope — never build here**

jobs · loads · customers · planning · dispatch · routing · GPS tracking · live
driver tracking · POD · delivery management · invoicing · fleet utilisation ·
maintenance planning · vehicle scheduling · transport management · tachograph
replacement · payroll processing · operational analytics · CRM

Anything on that list belongs in the separate LogisticBay TMS product.

---

## The proposition

> Replace your drivers' paper timesheets and daily vehicle checks with their
> phone. Completed forms are automatically emailed to your office as PDFs.

The customer should not need to adopt a fleet-management system. Setup is:
create account → company name → destination email → configure checks →
subscribe → get activation code → give drivers access.

The convenience is concrete: on paper, a driver who uses three trailers in a day
fills in and carries three separate check sheets. Here it is a few taps and one
PDF.

---

## Driver philosophy

The driver interacts with the app **as little as possible**.

- **Morning:** open → start → *(pick company — only if he drives for more than one)* → truck → trailer → checks → done
- **During the day:** nothing
- **If an asset changes:** open → change truck/trailer → check → done
- **Evening:** open → finish → confirm → sign → submit

No driving/working/break/POA status updates. No job interaction. No GPS tracking.
No background monitoring. **Every additional mandatory tap needs justification.**

---

## Key concept — "segment"

In this product a **segment** is an **asset-use segment**: which truck and which
trailer the driver was using, between which times. It is **not** a working-time
or activity segment.

Example:

```
05:43 – 11:30   Truck AB24 XYZ  +  Trailer C123
11:30 – 14:20   Truck AB24 XYZ  +  Trailer C827
14:20 – finish  Truck CD25 XYZ  +  Trailer C827
```

Its purpose is to document which vehicles the driver used and checked. When an
asset changes, the app determines whether a check is required and prompts for it.

---

## Defects

A defect record carries: asset, date/time, check item, a **written description**,
driver identity, and the declaration info the form requires. It appears on the
day's PDF.

**No photographs in V1** (DECISIONS.md D10). A defect is a written explanation,
nothing more.

This is **not** a maintenance-management system. No workshop management, repair
scheduling, parts, PMI scheduling or VOR fleet management.

---

## The company PDF

A professional PDF replicating the paper form: company name; driver name and
payroll identifier if configured; date, start, finish, elapsed duration; all
trucks and trailers used with change times; initial truck check, initial trailer
check, and any additional checks caused by asset changes; defects and evidence;
driver declaration/signature.

**Do not invent additional operational information.**

---

## Driver personal features (private)

Separate from the employer's submitted timesheet. The driver may **optionally**
record driving time, other work, POA, rest/break, distance, hourly pay, overtime
rates and allowances, and see estimated daily/weekly/monthly earnings and
personal history.

This is a **personal driver diary**, not employer fleet management.

Because a driver may work for several companies (DECISIONS.md D12), the diary
spans all of them — one view of the week's hours and earnings that no single
employer can produce. No company sees it, and no company learns that he drives for
another.

**Privacy boundary:** this data is private to the driver and never appears in the
company PDF or any company-facing view, unless explicitly authorised later.

---

## Company billing

The **company pays, not the driver**. Drivers never purchase the app personally
in order to submit their employer's timesheets. Pricing model is not frozen — do
not hard-code commercial assumptions.

---

## Offline behaviour

Drivers frequently work with poor connectivity. The core daily workflow must
survive losing internet: local in-progress timesheet and check state, safe
recovery after app restart, queued submission, and protection against duplicate
submissions. **Not** a general offline fleet-sync platform.

---

## Relationship to LogisticBay TMS

Same brand, different products, separate everything (see DECISIONS.md).

The driver app is kept **visually and structurally familiar** to the TMS driver
app, so a company upgrading to the full TMS costs its drivers no retraining. But
Timesheets must remain fully valuable standalone — a customer should be able to
use it indefinitely without ever adopting the TMS, and it must never be degraded
into a TMS sales funnel.

---

## Competitive position

Not competing with FleetCheck, CheckedSafe, HauliK or Zohti by adding more
fleet-management features — the opposite:

> We don't make you adopt a fleet-management system just to stop using paper.

Differentiation: simplicity, fast onboarding, low driver friction, low operating
cost, sensible pricing, straightforward PDF delivery, driver personal utility.
