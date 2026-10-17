/**
 * Whether the app SENDS company timesheets (D66 stage S6).
 *
 * Off until the company website can receive them (S8): the D66 plan keeps
 * Save & Send hidden until then, and the app is not distributed, so one
 * constant is the switch — no remote flag. While it is off nothing is queued,
 * nothing is sent, and the declaration says plainly that nothing is sent.
 * Tests turn it on by mocking this module.
 */
export const SEND_TIMESHEETS: boolean = false;
