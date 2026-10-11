/**
 * D63, stage 5 — the driver sees a company's invitation in the app and
 * answers it: Accept, Decline or Not now.
 *
 *   - only a driver whose email is confirmed sees invitations — the server
 *     says EMAIL_NOT_VERIFIED otherwise, and the app shows nothing for it
 *     (the Confirm your email card is the next step);
 *   - each invitation says who invited, as whom, until when, and what the
 *     company will see: name and email — nothing else;
 *   - Accept joins: the account is read again, so the company is at once in
 *     the driver's companies — and so under Working for at Start Shift;
 *   - Decline asks first and says the company will see it (owner decision);
 *   - Not now asks the server nothing: the invitation stays open;
 *   - nothing claims a join or a decline that did not happen; a double tap
 *     is one request; an invitation answered elsewhere is said to be gone.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { Invitations } from "../components/Invitations";
import type { AuthenticatedAccount } from "../api/account";

const USER = { id: "user_inv", firstName: "Ivy", lastName: "Invited", email: "ivy@example.com" };
const SIGNED_IN: AuthenticatedAccount = { user: USER, memberships: [], identityToken: "id.token", refreshToken: "secret-1" };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const NORTHGATE = { membershipId: "m-north", companyId: "c-north", companyName: "Northgate Logistics", role: "driver" };

type View = Awaited<ReturnType<typeof render>>;

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
}

function invitation(over: Record<string, unknown> = {}) {
  return { id: "inv-north", companyName: "Northgate Logistics", firstName: "Ivy", lastName: "Invited", expiresAt: "2026-11-10T08:00:00.000Z", ...over };
}

interface Server {
  invitations: unknown[];
  memberships: unknown[];
  requests: string[];
  list: () => Promise<Response>;
  accept: (id: string) => Promise<Response>;
  decline: (id: string) => Promise<Response>;
}

function server(options: Partial<Pick<Server, "list" | "accept" | "decline">> & { invitations?: unknown[] } = {}): Server {
  const state: Server = {
    invitations: options.invitations ?? [invitation()],
    memberships: [],
    requests: [],
    list: options.list ?? (() => jsonResponse(200, { invitations: state.invitations })),
    accept: options.accept ?? (id => {
      state.invitations = state.invitations.filter(i => (i as { id: string }).id !== id);
      state.memberships = [NORTHGATE];
      return jsonResponse(200, { membership: NORTHGATE });
    }),
    decline: options.decline ?? (id => {
      state.invitations = state.invitations.filter(i => (i as { id: string }).id !== id);
      return jsonResponse(204, null);
    }),
  };
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    state.requests.push(`${method} ${url.pathname} ${new Headers(init.headers).get("authorization") ?? ""}`);
    if (url.pathname === "/driver/invitations") return state.list();
    const answered = /^\/driver\/invitations\/([^/]+)\/(accept|decline)$/.exec(url.pathname);
    if (answered !== null) return answered[2] === "accept" ? state.accept(answered[1] ?? "") : state.decline(answered[1] ?? "");
    if (url.pathname === "/auth/me") return jsonResponse(200, { user: USER, memberships: state.memberships, emailVerified: true });
    throw new Error(`unexpected request to ${url.pathname}`);
  }) as unknown as typeof fetch);
  return state;
}

function Phone() {
  const { signIn, status, account } = useAuth();
  return (
    <>
      <Pressable testID="sign-in" onPress={() => { void signIn(SIGNED_IN); }}><Text>{status}</Text></Pressable>
      <Text testID="my-companies">{(account?.memberships ?? []).map(m => m.companyName).join(",")}</Text>
      {status === "authenticated" ? <Invitations /> : null}
    </>
  );
}

async function signedIn(): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Phone /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(view.getByTestId("sign-in")).toBeTruthy(); });
  await act(async () => { await fireEvent.press(view.getByTestId("sign-in")); });
  return view;
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

const companies = (view: View): string => String(view.getByTestId("my-companies").props.children);
const answers = (api: Server): string[] => api.requests.filter(r => /accept|decline/.test(r));

beforeEach(async () => { await SecureStore.deleteItemAsync("logisticbay.refreshToken"); });
afterEach(() => { jest.restoreAllMocks(); });

test("INV1. each open invitation says who invited, as whom, until when — and that the company will see the driver's name and email", async () => {
  const api = server({ invitations: [invitation(), invitation({ id: "inv-sea", companyName: "Seaway Freight", firstName: "Ivy-Rose" })] });
  const view = await signedIn();

  await waitFor(() => { expect(view.getByTestId("invitation-inv-north")).toBeTruthy(); });
  expect(view.getByTestId("invitation-inv-sea")).toBeTruthy();
  const north = view.getByTestId("invitation-inv-north-text").props.children as string;
  expect(north).toMatch(/Northgate Logistics has added you as a driver/);
  expect(north).toMatch(/as Ivy Invited/);
  expect(view.getByTestId("invitation-inv-north-privacy").props.children).toMatch(/will see your name and email address/i);
  expect(view.getByTestId("invitation-inv-north-expiry").props.children).toMatch(/10 Nov 2026/);
  expect(api.requests).toContain("GET /driver/invitations Bearer id.token");
});

test("INV2. Accept joins the company: the account is read again, so it is at once among the driver's companies — the ones Start Shift offers under Working for", async () => {
  const api = server();
  const view = await signedIn();
  await waitFor(() => { expect(view.getByTestId("invitation-inv-north-accept")).toBeTruthy(); });
  expect(companies(view)).toBe("");

  await press(view, "invitation-inv-north-accept");

  await waitFor(() => { expect(companies(view)).toBe("Northgate Logistics"); });
  expect(answers(api)).toEqual(["POST /driver/invitations/inv-north/accept Bearer id.token"]);
  expect(api.requests).toContain("GET /auth/me Bearer id.token");
  expect(view.getByTestId("invitations-message").props.children).toMatch(/joined Northgate Logistics/i);
  expect(view.getByTestId("invitations-message").props.children).toMatch(/Working for/);
  expect(view.queryByTestId("invitation-inv-north")).toBeNull();
});

test("INV3. Decline asks first, saying the company will see it; confirming declines — no company joined", async () => {
  const api = server();
  const view = await signedIn();
  await waitFor(() => { expect(view.getByTestId("invitation-inv-north-decline")).toBeTruthy(); });

  await press(view, "invitation-inv-north-decline");
  // One tap asks; it does not decline.
  expect(answers(api)).toEqual([]);
  expect(view.getByTestId("invitation-inv-north-confirm").props.children).toMatch(/Northgate Logistics will see that you declined/);

  await press(view, "invitation-inv-north-decline-confirm");

  await waitFor(() => { expect(view.queryByTestId("invitation-inv-north")).toBeNull(); });
  expect(answers(api)).toEqual(["POST /driver/invitations/inv-north/decline Bearer id.token"]);
  expect(companies(view)).toBe("");
  expect(view.getByTestId("invitations-message").props.children).toMatch(/declined/i);
});

test("INV4. Not now asks the server nothing: the invitation is put aside on this screen and stays open", async () => {
  const api = server();
  const view = await signedIn();
  await waitFor(() => { expect(view.getByTestId("invitation-inv-north-later")).toBeTruthy(); });

  await press(view, "invitation-inv-north-later");

  expect(view.queryByTestId("invitation-inv-north")).toBeNull();
  expect(answers(api)).toEqual([]);
  expect(api.invitations).toHaveLength(1);
});

test("INV5. an unconfirmed email: the server says so, and the app shows no invitations — nothing to answer, nothing broken", async () => {
  server({ list: () => jsonResponse(403, { error: "Confirm your email address to see invitations", code: "EMAIL_NOT_VERIFIED" }) });
  const view = await signedIn();
  await waitFor(() => { expect(view.getByText("authenticated")).toBeTruthy(); });
  await act(async () => { await Promise.resolve(); });

  expect(view.queryByTestId("invitations")).toBeNull();
  expect(view.queryByTestId("invitations-message")).toBeNull();
});

test("INV6. an invitation answered elsewhere, cancelled or expired meanwhile: said to be no longer open, and the list read again", async () => {
  const api = server({ accept: () => { api.invitations = []; return jsonResponse(409, { error: "x", code: "INVITATION_NOT_PENDING" }); } });
  const view = await signedIn();
  await waitFor(() => { expect(view.getByTestId("invitation-inv-north-accept")).toBeTruthy(); });

  await press(view, "invitation-inv-north-accept");

  await waitFor(() => { expect(view.getByTestId("invitations-message").props.children).toMatch(/no longer open/i); });
  expect(view.queryByTestId("invitation-inv-north")).toBeNull();
  expect(companies(view)).toBe("");
});

test("INV7. no connection: said plainly, nothing claimed, and the invitation can be answered again", async () => {
  server({ accept: () => Promise.reject(new TypeError("Network request failed")) });
  const view = await signedIn();
  await waitFor(() => { expect(view.getByTestId("invitation-inv-north-accept")).toBeTruthy(); });

  await press(view, "invitation-inv-north-accept");

  await waitFor(() => { expect(view.getByTestId("invitations-message").props.children).toMatch(/no connection/i); });
  expect(view.getByTestId("invitations-message").props.children).not.toMatch(/joined/i);
  expect(view.getByTestId("invitation-inv-north-accept")).toBeTruthy();
  expect(companies(view)).toBe("");
});

test("INV8. a double tap on Accept is ONE request", async () => {
  let answer: (response: Response) => void = () => undefined;
  const api = server({ accept: () => new Promise<Response>(resolve => { answer = resolve; }) });
  const view = await signedIn();
  await waitFor(() => { expect(view.getByTestId("invitation-inv-north-accept")).toBeTruthy(); });

  await act(async () => {
    await Promise.all([
      fireEvent.press(view.getByTestId("invitation-inv-north-accept")),
      fireEvent.press(view.getByTestId("invitation-inv-north-accept")),
    ]);
  });
  api.memberships = [NORTHGATE];
  await act(async () => {
    answer({ ok: true, status: 200, json: () => Promise.resolve({ membership: NORTHGATE }) } as Response);
    await Promise.resolve();
  });

  await waitFor(() => { expect(companies(view)).toBe("Northgate Logistics"); });
  expect(answers(api)).toHaveLength(1);
});

test("INV9. with no open invitations there is nothing on screen", async () => {
  server({ invitations: [] });
  const view = await signedIn();
  await waitFor(() => { expect(view.getByText("authenticated")).toBeTruthy(); });
  await act(async () => { await Promise.resolve(); });
  expect(view.queryByTestId("invitations")).toBeNull();
});
