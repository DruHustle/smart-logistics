import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import app from "../src/app";
import { connection } from "../src/config/db";
import { migrate } from "../src/migrate";
import { hashPassword } from "../src/services/passwords";

test("Portal callback preserves identity, least privilege, deep links and revocation in PostgreSQL", async () => {
  const db = new URL(process.env.DATABASE_URL || "http://invalid");
  assert.ok(["127.0.0.1", "localhost"].includes(db.hostname) && db.pathname.endsWith("_test"), "Use an explicit isolated loopback *_test database");
  const issuer = "https://portal.example.test/api/v1/identity", origin = "https://logistics.example.test";
  Object.assign(process.env, { ONESA_IDENTITY_ENABLED: "true", ONESA_IDENTITY_ISSUER: issuer, ONESA_IDENTITY_CLIENT_ID: "logistics-test-client", ONESA_IDENTITY_CLIENT_SECRET: "s".repeat(64), ONESA_IDENTITY_REDIRECT_URI: origin + "/api/auth/onesa/callback", CORS_ALLOWED_ORIGINS: origin, ALLOWED_ORIGIN: origin });
  await migrate();
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let sub = randomUUID(), active = true, role = "user";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === issuer + "/token") return Response.json({ access_token: "synthetic-central-grant-".repeat(2), token_type: "Bearer" });
    if (url === issuer + "/session") {
      const now = Math.floor(Date.now()/1000);
      return Response.json({ active, iss: issuer, aud: "logistics-test-client", sub, email: `${sub}@example.test`, email_verified: true, name: "Synthetic Portal member", exp: now+600, auth_time: now-2, amr: role === "admin" ? ["pwd", "otp"] : ["pwd"], onesa_roles: role === "admin" ? ["global_admin"] : [], onesa_applications: ["logistics"], onesa_product_roles: { logistics: role } });
    }
    return originalFetch(input, init);
  };
  const request = (path: string, cookie = "", body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", redirect: "manual", headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signIn = async (link?: {email:string;password:string}) => {
    const start = await request("/api/auth/onesa/start", "", { returnTo: "#/supply-chain/shipments/123/tracking", ...(link ? {link} : {}) });
    assert.equal(start.status, 200);
    const state = new URL((await start.json()).url).searchParams.get("state")!;
    const cookies = start.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
    const path = "/api/auth/onesa/callback?code=synthetic-code&state=" + state;
    const callback = await request(path, cookies);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), origin + "/#/supply-chain/shipments/123/tracking");
    const session = callback.headers.getSetCookie().find(v => v.startsWith("imsop_access="))!.split(";")[0];
    const replay = await request(path, cookies);
    assert.match(replay.headers.get("location")!, /onesa=restart$/);
    return session;
  };
  try {
    const first = await signIn(), second = await signIn();
    const me = await request("/api/auth/me", first); assert.equal(me.status, 200);
    assert.equal((await me.json()).user.role, "user");
    const saved = await connection.query("SELECT id,role,active_workspace_id FROM users WHERE onesa_issuer=$1 AND onesa_subject=$2", [issuer,sub]);
    assert.equal(saved.rowCount, 1); assert.equal(saved.rows[0].role, "user"); assert.equal(saved.rows[0].active_workspace_id, null);
    assert.equal((await request("/api/operations/shipments", second)).status, 403);
    const workspace=randomUUID(), otherWorkspace=randomUUID();
    await connection.query("INSERT INTO workspaces(id,name) VALUES($1,'Assigned synthetic workspace'),($2,'Other synthetic workspace')",[workspace,otherWorkspace]);
    await connection.query("INSERT INTO workspace_memberships(user_id,workspace_id) VALUES($1,$2)",[saved.rows[0].id,workspace]);
    await connection.query("UPDATE users SET active_workspace_id=$1 WHERE id=$2",[workspace,saved.rows[0].id]);
    const foreign=(await connection.query("INSERT INTO shipments(workspace_id,tracking_number,origin,destination,status) VALUES($1,$2,'A','B','delayed') RETURNING id",[otherWorkspace,randomUUID()])).rows[0];
    const assigned=await signIn();
    assert.equal((await request("/api/operations/shipments/"+foreign.id,assigned)).status,404);
    assert.equal((await (await request("/api/operations/shipments?limit=10",assigned)).json()).total,0);
    active = false; assert.equal((await request("/api/auth/me", first)).status, 401);
    active=true;sub=randomUUID();
    const localPassword="Synthetic-local-link-password-2026";
    const local=(await connection.query("INSERT INTO users(email,password,name,role,active_workspace_id) VALUES($1,$2,'Existing synthetic engineer','engineer',$3) RETURNING id",[`${sub}@example.test`,await hashPassword(localPassword),workspace])).rows[0];
    await connection.query("INSERT INTO workspace_memberships(user_id,workspace_id) VALUES($1,$2)",[local.id,workspace]);
    const linked=await signIn({email:`${sub}@example.test`,password:localPassword});
    const linkedMe=(await (await request("/api/auth/me",linked)).json()).user;
    assert.equal(linkedMe.id,String(local.id));assert.equal(linkedMe.role,"engineer");
    assert.equal((await request("/api/operations/shipments/"+foreign.id,linked)).status,404);
    active=false;assert.equal((await request("/api/auth/me",linked)).status,401);
    active=true;assert.equal((await request("/api/auth/me",linked)).status,401,"A revoked local session must not revive when the central grant becomes active again");
    active = true; sub = randomUUID(); role = "admin";
    const admin = await signIn(); assert.equal((await (await request("/api/auth/me", admin)).json()).user.role, "admin");
    role = "user"; assert.equal((await request("/api/auth/me", admin)).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await connection.end();
  }
});
