/**
 * expo-secure-store is a NATIVE module and cannot run under Jest. It is
 * mocked here at the module boundary rather than inside each test, so every
 * test exercises the app's real `secureStore` wrapper — the thing whose
 * behaviour matters — against a stand-in for the platform keychain.
 *
 * The mock is deliberately an in-memory store rather than a set of empty
 * spies: a test asserting "the refresh secret was stored" must be able to
 * fail if the app writes nothing.
 */
// The `mock` prefix is required: Jest hoists mock factories above the file's
// own declarations and rejects out-of-scope references without it.
const mockMemory = new Map();

jest.mock("expo-secure-store", () => ({
  __esModule: true,
  setItemAsync: jest.fn((key, value) => {
    mockMemory.set(key, value);
    return Promise.resolve();
  }),
  getItemAsync: jest.fn(key => Promise.resolve(mockMemory.has(key) ? mockMemory.get(key) : null)),
  deleteItemAsync: jest.fn(key => {
    mockMemory.delete(key);
    return Promise.resolve();
  }),
  __memory: mockMemory,
}));

beforeEach(() => {
  mockMemory.clear();
  jest.clearAllMocks();
});

/**
 * expo-local-authentication is a NATIVE module and cannot run under Jest.
 * Mocked at the module boundary so every test exercises the app's real
 * `biometrics.ts` wrapper — the thing whose behaviour matters — against a
 * controllable stand-in for the platform.
 *
 * The defaults describe the COMMON case rather than the convenient one: a
 * device with no biometric hardware. A test that wants a capable device says
 * so explicitly, which keeps "what happens on an ordinary phone" the default
 * everywhere.
 */
const mockLocalAuth = {
  hasHardwareAsync: jest.fn(() => Promise.resolve(false)),
  isEnrolledAsync: jest.fn(() => Promise.resolve(false)),
  supportedAuthenticationTypesAsync: jest.fn(() => Promise.resolve([])),
  authenticateAsync: jest.fn(() => Promise.resolve({ success: false, error: "not_available" })),
  cancelAuthenticate: jest.fn(() => Promise.resolve()),
  // The real enum values, so a test cannot pass against an invented number.
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
};

jest.mock("expo-local-authentication", () => mockLocalAuth);

beforeEach(() => {
  mockLocalAuth.hasHardwareAsync.mockResolvedValue(false);
  mockLocalAuth.isEnrolledAsync.mockResolvedValue(false);
  mockLocalAuth.supportedAuthenticationTypesAsync.mockResolvedValue([]);
  mockLocalAuth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
});
