/**
 * D66, stage S3 — start receipts on the phone.
 *
 * A company's day queues a receipt; the sync runner sends it when it can.
 * Nothing waits on it: the day starts offline. The queue is files in the
 * account's own directory — it survives a restart and is never another
 * driver's — and every retry is the same request. A refusal the server means
 * is final; anything else waits for the next chance.
 */
import { render, act } from "@testing-library/react-native";
import { File } from "expo-file-system";
import * as Network from "expo-network";
import { clearOpenShift, correctOpenShift, startLocalShift, type WorkingContext } from "../shift/localShift";
import { RECEIPT_FILE_PREFIX, RECEIPT_STATE, listReceipts, queueStartReceipt } from "../sync/receiptQueue";
import { runSync, type WithIdentity } from "../sync/syncRunner";
import { SyncDriver, requestSync } from "../sync/SyncDriver";
import { accountDirectoryOf, scopeFor } from "./testScope";

const SCOPE = scopeFor("user_receipts_1");
const OTHER = scopeFor("user_receipts_2");
jest.mock("../shift/useAccountScope", () => ({ useAccountScope: () => mockScope }));
const mockScope = SCOPE;
const mockIdentity: WithIdentity = call => call("id.token");
jest.mock("../auth/AuthContext", () => ({ useAuth: () => ({ withIdentity: mockIdentity }) }));

const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m_north", companyId: "c_north", companyName: "Northgate Haulage" };
const at = (hours: number) => new Date(2026, 9, 11, hours, 0);

interface Sent { path: string; authorization: string | null; body: unknown }
type Answer = () => Promise<Response>;

function server(answer: Answer): Sent[] {
  const sent: Sent[] = [];
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    sent.push({ path: new URL(String(input)).pathname, authorization: new Headers(init.headers).get("authorization"), body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : null });
    return answer();
  }) as unknown as typeof fetch);
  return sent;
}

const answer = (status: number, body: unknown = {}): Answer => () =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response);
const RECEIVED = answer(201, { receipt: { receivedAt: "2026-10-11T03:00:01.000Z" } });
const OFFLINE: Answer = () => Promise.reject(new TypeError("Network request failed"));

function clearReceipts(scope: typeof SCOPE) {
  for (const entry of accountDirectoryOf(scope).list()) {
    if (entry instanceof File && entry.name.startsWith(RECEIPT_FILE_PREFIX)) entry.delete();
  }
}

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  await clearOpenShift(OTHER);
  clearReceipts(SCOPE);
  clearReceipts(OTHER);
});
afterEach(() => { jest.restoreAllMocks(); });

test("SQ1. a company's open day gets its receipt queued and sent — the day's id, the company, the declared start, the identity token — and keeps the SERVER's time", async () => {
  const sent = server(RECEIVED);
  const day = await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });

  const report = await runSync(SCOPE, mockIdentity);

  expect(sent).toEqual([{ path: "/driver/shift-receipts", authorization: "Bearer id.token", body: { membershipId: "m_north", clientEventId: day.id, startedAt: at(6).toISOString() } }]);
  expect(report).toMatchObject({ received: 1, waiting: 0, retryLater: false });
  expect(listReceipts(SCOPE)).toMatchObject([{ dayId: day.id, state: RECEIPT_STATE.received, receivedAt: "2026-10-11T03:00:01.000Z", attempts: 1 }]);
});

test("SQ2. a Personal day has no receipt, and a run with nothing queued asks the server NOTHING", async () => {
  const sent = server(RECEIVED);
  await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: null });

  await runSync(SCOPE, mockIdentity);

  expect(sent).toEqual([]);
  expect(listReceipts(SCOPE)).toEqual([]);
});

test("SQ3. no connection: the receipt waits — the day is untouched — and the next run sends the SAME request", async () => {
  const sent = server(OFFLINE);
  const day = await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });

  const first = await runSync(SCOPE, mockIdentity);
  expect(first).toMatchObject({ waiting: 1, retryLater: true });
  expect(listReceipts(SCOPE)).toMatchObject([{ state: RECEIPT_STATE.waiting, attempts: 1 }]);

  jest.restoreAllMocks();
  const retried = server(RECEIVED);
  await runSync(SCOPE, mockIdentity);

  expect(retried[0]?.body).toEqual(sent[0]?.body);
  expect(listReceipts(SCOPE)).toMatchObject([{ dayId: day.id, state: RECEIPT_STATE.received, attempts: 2 }]);
});

test.each([[403], [404], [409], [400]])("SQ4. a %s the server means is FINAL: the receipt is refused and never sent again", async status => {
  server(answer(status, { error: "x", code: "FORBIDDEN" }));
  await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });

  const report = await runSync(SCOPE, mockIdentity);
  expect(report).toMatchObject({ refused: 1, retryLater: false });

  jest.restoreAllMocks();
  const later = server(RECEIVED);
  await runSync(SCOPE, mockIdentity);
  expect(later).toEqual([]);
});

test.each([[429], [500], [503]])("SQ5. a %s may differ next time: the receipt waits", async status => {
  server(answer(status, { error: "x" }));
  await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });

  expect(await runSync(SCOPE, mockIdentity)).toMatchObject({ waiting: 1, retryLater: true });
});

test("SQ6. the queue is on disk: it outlives the run that made it, and its payload is FIXED — a later correction of the start does not change what is sent", async () => {
  server(OFFLINE);
  const day = await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });
  await runSync(SCOPE, mockIdentity);
  await correctOpenShift(SCOPE, { shiftId: day.id, workingFor: NORTHGATE, startedAt: at(5) });

  jest.restoreAllMocks();
  const sent = server(RECEIVED);
  await runSync(SCOPE, mockIdentity);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toMatchObject({ startedAt: at(6).toISOString() });
});

test("SQ7. another driver on the phone never sees or sends this one's receipts", async () => {
  const sent = server(OFFLINE);
  await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });
  await runSync(SCOPE, mockIdentity);
  sent.length = 0;

  await runSync(OTHER, mockIdentity);

  expect(sent).toEqual([]);
  expect(listReceipts(OTHER)).toEqual([]);
});

test("SQ8. two runs at once are ONE run — the receipt is sent once", async () => {
  const sent = server(RECEIVED);
  await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });

  await Promise.all([runSync(SCOPE, mockIdentity), runSync(SCOPE, mockIdentity), runSync(SCOPE, mockIdentity)]);

  expect(sent).toHaveLength(1);
});

test("SQ9. a receipt queued for a FINISHED day made a company's is sent like any other; queueing the same one twice keeps the first", async () => {
  const sent = server(RECEIVED);
  queueStartReceipt(SCOPE, { dayId: "11111111-2222-4333-8444-555555555555", membershipId: "m_north", startedAt: at(6).toISOString() }, at(7));
  queueStartReceipt(SCOPE, { dayId: "11111111-2222-4333-8444-555555555555", membershipId: "m_north", startedAt: at(9).toISOString() }, at(10));

  await runSync(SCOPE, mockIdentity);

  expect(sent.map(s => s.body)).toEqual([{ membershipId: "m_north", clientEventId: "11111111-2222-4333-8444-555555555555", startedAt: at(6).toISOString() }]);
});

test("SQ10. a receipt file that cannot be read is left exactly as it is and never sent", async () => {
  const sent = server(RECEIVED);
  const broken = new File(accountDirectoryOf(SCOPE), `${RECEIPT_FILE_PREFIX}broken.json`);
  broken.create({ overwrite: true });
  broken.write("{ not json");

  await runSync(SCOPE, mockIdentity);

  expect(sent).toEqual([]);
  expect(broken.textSync()).toBe("{ not json");
  broken.delete();
});

test("SQ11. the driver runs when the app opens signed in, when asked, and when the connection RETURNS — and stops listening when it goes", async () => {
  const sent = server(OFFLINE);
  await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });
  const network = Network as unknown as { __emit: (state: object) => void; __listeners: Set<unknown> };

  const view = await render(<SyncDriver />);
  await act(async () => { await Promise.resolve(); });
  expect(sent).toHaveLength(1);

  jest.restoreAllMocks();
  const online = server(RECEIVED);
  await act(async () => {
    network.__emit({ isConnected: false, isInternetReachable: false });
    network.__emit({ isConnected: true, isInternetReachable: true });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(online).toHaveLength(1);
  expect(listReceipts(SCOPE)).toMatchObject([{ state: RECEIPT_STATE.received }]);

  await act(async () => { requestSync(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(online).toHaveLength(1);

  await view.unmount();
  expect(network.__listeners.size).toBe(0);
});
