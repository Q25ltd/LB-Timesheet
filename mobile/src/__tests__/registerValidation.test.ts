/**
 * Registration's client-side rules. Logic, not pixels — these are the
 * decisions the screen makes before it touches the network.
 *
 * The SERVER remains the authority (api/src/services/registration.ts); what
 * is proven here is that the client does not contradict it, and in
 * particular that it uses the same UNIT for the password cap.
 */
import { validateRegistration, fieldErrorsFromServer } from "../screens/registerValidation";
import { PASSWORD_RULE_TEXT, utf8ByteLength } from "../auth/passwordPolicy";

const VALID = {
  firstName:       "Nerijus",
  lastName:        "Kuizinas",
  email:           "driver@example.com",
  password:        "correct-horse-battery",
  // A FORM field only — never part of the request body (D21).
  confirmPassword: "correct-horse-battery",
};

test("a complete, valid form has no errors", () => {
  expect(validateRegistration(VALID)).toEqual({});
});

test("every one of the four fields is required", () => {
  for (const field of ["firstName", "lastName", "email", "password"] as const) {
    const errors = validateRegistration({ ...VALID, [field]: "" });
    expect(errors[field]).toBeDefined();
  }
});

test("whitespace is not a name", () => {
  const errors = validateRegistration({ ...VALID, firstName: "   ", lastName: "  " });
  expect(errors.firstName).toBeDefined();
  expect(errors.lastName).toBeDefined();
});

test("a malformed email is rejected before the network is touched", () => {
  for (const email of ["not-an-email", "driver@", "@example.com", "driver example@x.com"]) {
    expect(validateRegistration({ ...VALID, email }).email).toBeDefined();
  }
});

test("a password under 10 characters is refused, and the message is the rule the UI shows", () => {
  const errors = validateRegistration({ ...VALID, password: "123456789" });
  expect(errors.password).toBe(PASSWORD_RULE_TEXT);
  expect(validateRegistration({ ...VALID, password: "1234567890" }).password).toBeUndefined();
});

test("the 72-byte cap is measured in UTF-8 BYTES, not JavaScript characters", () => {
  // The case the rule exists for: 25 lorries are 50 code units — under any
  // character cap of 72 — and 100 UTF-8 bytes, which bcrypt would truncate.
  const lorries = "🚚".repeat(25);
  expect(lorries.length).toBe(50);
  expect(utf8ByteLength(lorries)).toBe(100);
  expect(validateRegistration({ ...VALID, password: lorries }).password).toBeDefined();

  // And the control: 30 accented characters are 60 bytes and must pass.
  const accented = "é".repeat(30);
  expect(utf8ByteLength(accented)).toBe(60);
  expect(validateRegistration({ ...VALID, password: accented }).password).toBeUndefined();
});

test("a password is never trimmed — whitespace is part of the credential", () => {
  const padded = "  ten chars plus  ";
  expect(validateRegistration({ ...VALID, password: padded, confirmPassword: padded }).password).toBeUndefined();
});

test("the repeat password must be entered and must match exactly", () => {
  expect(validateRegistration({ ...VALID, confirmPassword: "" }).confirmPassword)
    .toBe("Re-enter your password");
  expect(validateRegistration({ ...VALID, confirmPassword: "something-else-x" }).confirmPassword)
    .toBe("Passwords do not match");

  // Compared exactly, for the same reason neither side is trimmed: a
  // trailing space is part of one secret and not the other.
  expect(validateRegistration({ ...VALID, confirmPassword: `${VALID.password} ` }).confirmPassword)
    .toBe("Passwords do not match");

  expect(validateRegistration(VALID).confirmPassword).toBeUndefined();
});

test("a mismatch is not reported while the password itself is still unusable", () => {
  // Two complaints for one mistake is one too many: fix the password first.
  const errors = validateRegistration({ ...VALID, password: "short", confirmPassword: "" });
  expect(errors.password).toBeDefined();
  expect(errors.confirmPassword).toBeUndefined();
});

test("server field errors map onto the same field slots, and unknown paths are ignored", () => {
  const mapped = fieldErrorsFromServer([
    { path: "email", message: "Enter a valid email address" },
    { path: "companyId", message: "Unrecognized key" },
  ]);
  expect(mapped).toEqual({ email: "Enter a valid email address" });
});
