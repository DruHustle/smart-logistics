import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIdentity } from "../src/identity-http";

const endpoint = "https://logistics-api.onesa.eu/api/auth/onesa/native/config";

test("a stalled native OIDC API request has a finite, fail-closed deadline", async () => {
  let signal: AbortSignal | undefined;
  const neverCompletes = (async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    return await new Promise<Response>(() => {});
  }) as typeof fetch;
  await assert.rejects(fetchIdentity(endpoint, {}, 25, neverCompletes),
    /Onesa sign-in did not respond in time/);
  assert.equal(signal?.aborted, true);
});

test("a timely response preserves its body and cancels the deadline", async () => {
  let signal: AbortSignal | undefined;
  const response = new Response('{"enabled":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const quick = (async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return response;
  }) as typeof fetch;
  assert.equal(await fetchIdentity(endpoint, {}, 15, quick), response);
  assert.equal((await response.json()).enabled, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal?.aborted, false);
});

test("existing cancellation propagates to the native transport", async () => {
  const cancelled = new AbortController();
  const observer = (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    assert.equal(signal?.aborted, true);
    throw Error("Cancelled before network");
  }) as typeof fetch;
  cancelled.abort();
  await assert.rejects(fetchIdentity(endpoint, { signal: cancelled.signal }, 25, observer),
    /Cancelled before network/);
});
