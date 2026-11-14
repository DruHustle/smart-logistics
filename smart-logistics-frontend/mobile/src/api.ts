import { origin } from "./config";

export class SessionExpired extends Error {}
export async function request(
  session: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string
) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + session,
      "Content-Type": "application/json",
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401)
    throw new SessionExpired("Sign in again to reopen this record.");
  if (response.status === 403)
    throw Error("You do not have access to this action.");
  if (response.status === 404) throw Error("This record is unavailable.");
  if (response.status === 409)
    throw Error("Another operator updated this record. Refresh and try again.");
  if (!response.ok)
    throw Error(
      "The service could not complete your request. Refresh before retrying."
    );
  return response.status === 204 ? null : response.json();
}
export type Item = {
  id: number;
  title: string;
  summary: string;
  version: number;
  parent: number;
  owner?: number;
  due?: string | null;
  state: string;
};
export type Detail = { item: Item; history: string[] };

export async function list(session: string): Promise<Item[]> {
  const data = await request(session, "/api/operations/reviews?limit=50");
  return data.items.map((r: Review) => item(r));
}
type Review = {
  id: number;
  trackingNumber: string;
  shipmentId: number;
  version: number;
  state: string;
};
const item = (r: Review): Item => ({
  id: r.id,
  title: r.trackingNumber,
  summary: "Shipment " + r.shipmentId + " · " + r.state,
  version: r.version,
  parent: r.shipmentId,
  state: r.state,
});
export async function detail(session: string, id: string): Promise<Detail> {
  const data = await request(session, "/api/operations/reviews/" + id);
  const history = await request(
    session,
    "/api/operations/reviews/" + id + "/actions"
  );
  return {
    item: item(data),
    history: history.items.map(
      (a: { actorName: string; action: string; note?: string }) =>
        [a.actorName, a.action, a.note].filter(Boolean).join(" · ")
    ),
  };
}
export const actionLabel = "Resolve exception";
export async function complete(session: string, row: Item, note: string) {
  await request(session, "/api/operations/reviews/" + row.id + "/actions", {
    action: "resolve",
    note,
    version: row.version,
  });
}
export const keyOf = (r: Item) => String(r.id);
export const validKey = (s: string) => /^[1-9]\d{0,9}$/.test(s);
export const done = (r: Item) => r.state === "resolved";
export async function signOut(session: string) {
  await request(session, "/api/auth/logout", {});
}
