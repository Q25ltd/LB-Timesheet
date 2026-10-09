import activeShift360 from "../assets/screens/driver-active-checked-360.webp";
import activeShift720 from "../assets/screens/driver-active-checked-720.webp";
import startShift360 from "../assets/screens/driver-start-shift-360.webp";
import startShift720 from "../assets/screens/driver-start-shift-720.webp";
import unitCheck360 from "../assets/screens/driver-unit-check-360.webp";
import unitCheck720 from "../assets/screens/driver-unit-check-720.webp";
import "../styles/phone.css";

/**
 * The driver app, shown as it really is: each picture is a capture of the
 * Timesheets iOS app (`mobile/`, Release build, simulator) running against a
 * local API with fictional data — driver "Sam Taylor", vehicle "EX24 HAU".
 * Never production data, never a mock-up. "Working for: Personal" is what the
 * app really shows today: connecting a driver to a company is not built yet.
 *
 * Each is ONE described image (`alt`), so nobody is offered buttons that do
 * nothing. The capture's own proportions (1206 × 2622) are reserved, so the
 * page does not shift while it loads.
 */
const CAPTURE_WIDTH = 360;
const CAPTURE_HEIGHT = 783;

function PhoneFrame({ label, src, srcSet, eager = false }: { label: string; src: string; srcSet: string; eager?: boolean }) {
  return (
    <div className="phone">
      <div className="phone__device">
        <img
          className="phone__screen"
          src={src}
          srcSet={srcSet}
          sizes="(max-width: 639px) 60vw, 320px"
          width={CAPTURE_WIDTH}
          height={CAPTURE_HEIGHT}
          alt={label}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
        />
      </div>
    </div>
  );
}

export function ActiveShiftPhone() {
  return (
    <PhoneFrame
      eager
      label="The Timesheets driver app on a phone: an active shift for vehicle EX24 HAU, an articulated truck, with its start time, start mileage and the vehicle check completed, and buttons for fuel and AdBlue / DEF."
      src={activeShift360}
      srcSet={`${activeShift360} 360w, ${activeShift720} 720w`}
    />
  );
}

export function UnitCheckPhone() {
  return (
    <PhoneFrame
      label="The Timesheets driver app on a phone: the unit check for EX24 HAU, each item answered OK, N/A or Defect, with a running count of results and a Complete Check button."
      src={unitCheck360}
      srcSet={`${unitCheck360} 360w, ${unitCheck720} 720w`}
    />
  );
}

export function StartShiftPhone() {
  return (
    <PhoneFrame
      label="The Timesheets driver app on a phone: the Start Shift screen, with the start time, whether the driver has a vehicle, and the vehicle type."
      src={startShift360}
      srcSet={`${startShift360} 360w, ${startShift720} 720w`}
    />
  );
}
