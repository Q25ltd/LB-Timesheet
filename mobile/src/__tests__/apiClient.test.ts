/**
 * The API client's own failure classification, at the wire.
 *
 * The timeout must cover the WHOLE answer — headers and body. A server or
 * proxy that sends its headers and then stalls must end as a `network`
 * failure after the timeout, not hang the caller forever: app start waits on
 * this call, and a hang there is a splash screen that never ends.
 */
import { getJson } from "../api/client";

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Headers arrive at once; the body arrives only if never aborted. */
function stalledBody(status: number) {
  return jest.spyOn(global, "fetch").mockImplementation(((_url: string, init?: RequestInit) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new Error("Aborted")); });
    }),
  } as Response)) as unknown as typeof fetch);
}

test.each([200, 503])("a %i whose BODY stalls ends as a network failure when the timeout passes", async status => {
  jest.useFakeTimers();
  stalledBody(status);

  let settled: unknown = "pending";
  const call = getJson<unknown>("/auth/me", "token").then(result => { settled = result; });
  await jest.advanceTimersByTimeAsync(15_000);
  await call;

  expect(settled).toMatchObject({ kind: "network" });
});

test("an ordinary empty-bodied success (204) is still a success", async () => {
  jest.spyOn(global, "fetch").mockImplementation(() => Promise.resolve({
    ok: true,
    status: 204,
    json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
  } as Response));

  await expect(getJson<unknown>("/auth/logout", "token")).resolves.toMatchObject({ kind: "ok" });
});
