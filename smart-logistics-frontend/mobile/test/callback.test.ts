import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PendingOnesaTransactions,
  nativeCode,
  nativeRegistrationDestination,
  ownsNativeCallback,
  receiveBrowserCallback,
  type PendingOnesa,
} from "../src/callback";

test("a late signup return preserves only a usable in-app destination", () => {
  assert.equal(nativeRegistrationDestination('{"destination":"shipment-17","expires":1000}', 999), "shipment-17");
  assert.equal(nativeRegistrationDestination('{"destination":"shipment-17","expires":1000}', 1000), undefined);
  assert.equal(nativeRegistrationDestination('{"destination":null,"expires":1000}', 999), null);
  assert.equal(nativeRegistrationDestination('{"destination":null}', 999), null);
  assert.equal(nativeRegistrationDestination('{"destination":42,"expires":1000}', 999), undefined);
  assert.equal(nativeRegistrationDestination("{", 999), undefined);
});

test("an iOS browser dismissal retains the transaction for a following OS callback", async () => {
  const client = "eu.onesa.logistics://signin/callback";
  const pending: PendingOnesa = {
    issuer: "https://auth.onesa.eu/",
    origin: "https://logistics.example.test",
    expires: Date.now() + 300_000,
    verifier: "device-only",
    state: "current-attempt",
    destination: "17",
  };
  let listener: (url: string) => void = () => {};
  let removed = false;
  const match = `${client}?code=verified-test-code&state=${pending.state}`;
  const ready = receiveBrowserCallback(
    async () => ({ type: "cancel" }),
    receive => {
      listener = receive;
      return () => { removed = true; };
    },
    url => ownsNativeCallback(url, pending),
    100,
  );
  listener(match.replace(pending.state, "stale-attempt"));
  setTimeout(() => listener(match), 0);
  assert.equal(await ready, match);
  assert.equal(removed, true);
});

test("a dismissed browser with no accepted return stays signed out and releases the observer", async () => {
  let removed = false;
  const answer = await receiveBrowserCallback(
    async () => ({ type: "dismiss" }),
    receive => {
      receive("eu.onesa.logistics://signin/callback?state=old");
      return () => { removed = true; };
    },
    () => false,
    1,
  );
  assert.equal(answer, null);
  assert.equal(removed, true);
});

test("the app cannot treat a different browser result as completed sign-in or registration", async () => {
  const registered = "eu.onesa.logistics://signin/registered";
  const accepts = (value: string) => value === registered;
  const subscribe = () => () => {};
  await assert.rejects(receiveBrowserCallback(
    async () => ({ type: "success", url: registered + "?unexpected" }),
    subscribe,
    accepts,
    1,
  ), /unauthorized/);
  assert.equal(await receiveBrowserCallback(
    async () => ({ type: "success", url: registered }),
    subscribe,
    accepts,
    1,
  ), registered);
});

test("an app return requires the original pending transaction, issuer, exact route and API", () => {
  const origin = "https://farmer-api.example.test",
    issuer = "https://portal.example.test/api/v1/identity";
  const pending: PendingOnesa = {
    issuer,
    origin,
    expires: 1000,
    verifier: "device-only",
    state: "native_" + "a".repeat(64),
    destination: "17",
  };
  const target = new URL("eu.onesa.logistics://signin/callback");
  target.search = new URLSearchParams({
    code: "one-time-code",
    state: pending.state,
    iss: issuer,
  }).toString();
  assert.equal(nativeCode(target.href, pending, origin, 999), "one-time-code");
  for (const [field, value] of [
    ["state", "unrelated"],
    ["iss", "https://foreign.invalid"],
    ["error", "denied"],
  ] as const) {
    const modified = new URL(target);
    modified.searchParams.set(field, value);
    assert.throws(() => nativeCode(modified.href, pending, origin, 999));
  }
  assert.throws(() =>
    nativeCode(target.href, { ...pending, expires: 999 }, origin, 999)
  );
  assert.throws(() =>
    nativeCode(target.href, pending, "https://different.invalid", 999)
  );
  assert.throws(() =>
    nativeCode(target.href + "&code=duplicate", pending, origin, 999)
  );
  assert.throws(() =>
    nativeCode(
      target.href.replace("//signin/", "//foreign/"),
      pending,
      origin,
      999
    )
  );
  assert.throws(() =>
    nativeCode(
      target.href.replace("/callback?", "/else?"),
      pending,
      origin,
      999
    )
  );
});

test("a denied Portal transaction is surfaced only after matching its state and issuer", () => {
  const issuer = "https://portal.example.test/api/v1/identity";
  const origin = "https://farmer.example.test";
  const pending: PendingOnesa = {
    issuer,
    origin,
    expires: 1000,
    verifier: "device-only",
    state: "native_" + "a".repeat(64),
    destination: "42",
  };
  const callback = new URL("eu.onesa.logistics://signin/callback");
  callback.search = new URLSearchParams({
    state: pending.state,
    iss: issuer,
    error: "access_denied",
  }).toString();
  assert.throws(
    () => nativeCode(callback.href, pending, origin, 999),
    /onesa_denied/
  );
  callback.searchParams.set("state", "unrelated");
  assert.throws(
    () => nativeCode(callback.href, pending, origin, 999),
    /unauthorized/
  );
});

test("only one delivery claims a native transaction, and old cleanup preserves a new attempt", async () => {
  let value: string | null = null;
  const transactions = new PendingOnesaTransactions({
    read: async () => value,
    write: async next => {
      value = next;
    },
    remove: async () => {
      value = null;
    },
  });
  const origin = "https://farmer.example.test";
  const attempt: PendingOnesa = {
    origin,
    issuer: "https://portal.example.test/api/v1/identity",
    state: "first-attempt",
    verifier: "synthetic-device-verifier",
    destination: "17",
    expires: Date.now() + 300_000,
  };
  const callback =
    "eu.onesa.logistics://signin/callback?code=fixture&state=first-attempt";
  await transactions.save(attempt);
  const claims = await Promise.all([
    transactions.claim(callback, origin),
    transactions.claim(callback, origin),
  ]);
  assert.deepEqual(claims, [{ pending: attempt, code: "fixture" }, null]);

  const next = { ...attempt, state: "second-attempt" };
  await Promise.all([
    transactions.save(next),
    transactions.clear(attempt.state),
  ]);
  await assert.rejects(transactions.claim(callback, origin), /unauthorized/);
  assert.deepEqual(
    await transactions.claim(
      callback.replace("first-attempt", next.state),
      origin
    ),
    { pending: next, code: "fixture" }
  );

  await transactions.save(attempt);
  const denial = callback.replace("code=fixture", "error=access_denied");
  await assert.rejects(
    transactions.claim(denial + "&iss=https://unrelated.example", origin),
    /unauthorized/
  );
  await assert.rejects(transactions.claim(denial, origin), /onesa_denied/);
  assert.equal(await transactions.claim(callback, origin), null);
});
