import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import { connection } from "../src/config/db";
import { migrate } from "../src/migrate";
import { digest } from "../src/services/onesaIdentity";
import { hashPassword } from "../src/services/passwords";
import { queuePasswordReset } from "../src/services/resetDelivery";

test("One Onesa login creates a scoped Logistics session, checks live grants and requires proof for account links", async (t) => {
  assert.match(
    process.env.DATABASE_URL || "",
    /(?:localhost|127\.0\.0\.1):55467\/imsop_test/,
  );
  const issuer = "https://portal.example.test/api/v1/identity",
    origin = "https://logistics.example.test";
  const id = "test_logistics_client",
    secret = "integration-only-".repeat(4),
    redirect = origin + "/api/auth/onesa/callback";
  Object.assign(process.env, {
    ONESA_IDENTITY_ENABLED: "true",
    ONESA_IDENTITY_ISSUER: issuer,
    ONESA_IDENTITY_CLIENT_ID: id,
    ONESA_IDENTITY_CLIENT_SECRET: secret,
    ONESA_IDENTITY_REDIRECT_URI: redirect,
    CORS_ALLOWED_ORIGINS: origin,
  });
  await migrate(process.env.DATABASE_URL);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.close();
    await connection.end();
  });
  const socket = server.address();
  assert(socket && typeof socket !== "string");
  const root = "http://127.0.0.1:" + socket.port,
    http = globalThis.fetch;
  const sub = randomUUID(),
    email = sub + "@example.test";
  const now = Math.floor(Date.now() / 1000);
  let claims = {
    active: true,
    iss: issuer,
    aud: id,
    sub,
    email,
    email_verified: true,
    name: "Test Admin",
    exp: now + 600,
    auth_time: now,
    amr: ["pwd", "otp"],
    onesa_roles: ["global_admin"],
    onesa_applications: ["logistics"],
    onesa_product_roles: { logistics: "admin" },
  };
  const token = "opaque-integration-token-" + randomUUID();
  let challenge = "";
  t.mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
    assert.equal(
      new Headers(opts.headers).get("Authorization"),
      "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
    );
    if (url === issuer + "/session") {
      assert.deepEqual(JSON.parse(String(opts.body)), { token });
      return Response.json(claims);
    }
    assert.equal(url, issuer + "/token");
    const body = new URLSearchParams(String(opts.body));
    assert.equal(body.get("redirect_uri"), redirect);
    assert.equal(digest(body.get("code_verifier")!), challenge);
    return Response.json({ token_type: "Bearer", access_token: token });
  });
  async function start(link?: { email: string; password: string }) {
    const res = await http(root + "/api/auth/onesa/start", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(link ? { link } : {}),
    });
    assert.equal(res.status, 200);
    const url = new URL((await res.json()).url);
    assert.equal(url.origin + url.pathname, issuer + "/auth");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    challenge = url.searchParams.get("code_challenge")!;
    const path =
      "/api/auth/onesa/callback?code=example&state=" +
      url.searchParams.get("state");
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    return { path, cookie };
  }
  async function callback(tx: { path: string; cookie: string }) {
    return http(root + tx.path, {
      headers: { Cookie: tx.cookie },
      redirect: "manual",
    });
  }
  const tx = await start();
  assert.match(
    (await callback({ ...tx, cookie: "" })).headers.get("location")!,
    /restart/,
  );
  const signed = await callback(tx);
  assert.equal(signed.headers.get("location"), origin + "/#/");
  assert.match((await callback(tx)).headers.get("location")!, /restart/);
  const cookie = signed.headers
    .getSetCookie()
    .find((c) => c.startsWith("imsop_access="))!
    .split(";")[0];
  const session = () =>
    http(root + "/api/auth/session", { headers: { Cookie: cookie } });
  const view = await (await session()).json();
  assert.equal(view.role, "admin");
  assert.equal(view.workspaceId, null);
  await queuePasswordReset(email);
  assert.equal(
    (
      await connection.query(
        "SELECT id FROM reset_deliveries WHERE user_id=$1",
        [view.id],
      )
    ).rowCount,
    0,
  );
  claims.amr = ["pwd"];
  assert.equal((await session()).status, 401);
  claims.amr = ["otp"];
  claims.aud = "other";
  assert.equal((await session()).status, 401);
  claims.aud = id;
  claims.active = false;
  assert.equal((await session()).status, 401);
  claims.active = true;
  const localEmail = randomUUID() + "@example.test",
    password = "Local-account-proof-2026";
  const {
    rows: [local],
  } = await connection.query(
    "INSERT INTO users(email,name,password,role) VALUES($1,'Local',$2,'analyst') RETURNING id",
    [localEmail, await hashPassword(password)],
  );
  claims = { ...claims, sub: randomUUID(), email: localEmail };
  assert.match(
    (await callback(await start())).headers.get("location")!,
    /onesa=link/,
  );
  assert.equal(
    (
      await connection.query("SELECT onesa_subject FROM users WHERE id=$1", [
        local.id,
      ])
    ).rows[0].onesa_subject,
    null,
  );
  const linked = await callback(await start({ email: localEmail, password }));
  assert.equal(linked.headers.get("location"), origin + "/#/");
  const linkedCookie = linked.headers
    .getSetCookie()
    .find((c) => c.startsWith("imsop_access="))!
    .split(";")[0];
  const localView = await (
    await http(root + "/api/auth/session", {
      headers: { Cookie: linkedCookie },
    })
  ).json();
  assert.equal(localView.id, local.id);
  assert.equal(localView.role, "admin", "The live MFA Portal administrator has effective administrative access");
  assert.equal((await connection.query("SELECT role FROM users WHERE id=$1", [local.id])).rows[0].role, "analyst", "Federation must preserve the linked account's stored local role");
});
