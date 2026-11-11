import test from "node:test";
import assert from "node:assert/strict";
import { InactiveIdentity, liveIdentity, safeReturnPath } from "./services/onesaIdentity";

test("approved ordinary Portal identities are accepted without granting administration", async () => {
  const config = { issuer: "https://portal.example.test/api/v1/identity", client: "logistics-test-client", secret: "test-only", redirect: "https://logistics.example.test/api/auth/onesa/callback", origin: "https://logistics.example.test" };
  const now = Math.floor(Date.now() / 1000);
  let claims = { active: true, iss: config.issuer, aud: config.client, sub: "6518bd53-3f87-4b2f-bb52-b7df563da583", email: "ordinary@example.test", email_verified: true, name: "Synthetic member", exp: now + 600, auth_time: now - 2, amr: ["pwd"], onesa_roles: [] as string[], onesa_applications: ["logistics"], onesa_product_roles: { logistics: "user" } };
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json(claims);
  try {
    assert.equal((await liveIdentity(config, "synthetic-token")).onesa_product_roles.logistics, "user");
    claims = { ...claims, onesa_product_roles: { logistics: "admin" } };
    await assert.rejects(liveIdentity(config, "synthetic-token"), InactiveIdentity);
    claims = { ...claims, onesa_roles: ["global_admin"] };
    await assert.rejects(liveIdentity(config, "synthetic-token"), InactiveIdentity);
    claims = { ...claims, amr: ["pwd", "otp"] };
    assert.equal((await liveIdentity(config, "synthetic-token")).onesa_product_roles.logistics, "admin");
    for (const change of [{ active: false }, { exp: now - 1 }, { exp: now + 86401 }, { onesa_applications: [] }, { sub: "invalid" }, { aud: "different-client" }, { iss: "https://other.example" }, { email_verified: false }]) {
      const valid = claims;
      claims = { ...claims, ...change };
      await assert.rejects(liveIdentity(config, "synthetic-token"), InactiveIdentity);
      claims = valid;
    }
  } finally { globalThis.fetch = original; }
});

test("Onesa returns keep local shipment destinations and reject external or credential destinations", () => {
  assert.equal(safeReturnPath("#/supply-chain/shipments/123/tracking?view=events"), "#/supply-chain/shipments/123/tracking?view=events");
  for (const value of [undefined, "https://evil.example", "//evil.example", "#//evil.example", "#/\\evil.example", "#/login?token=secret", "#/register", "#/reset-password", "#/forgot-password", "#/\nLocation:evil", "#/" + "x".repeat(2048)]) assert.equal(safeReturnPath(value), "#/");
});
