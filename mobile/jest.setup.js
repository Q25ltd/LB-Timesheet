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
