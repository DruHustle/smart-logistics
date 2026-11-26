import { Router } from "express";
import { z } from "zod";
import { connection } from "../config/db";
import { authCookieOptions, createSession } from "../services/authSession";
import {
  authorizationUrl,
  digest,
  exchangeCode,
  identityConfig,
  InactiveIdentity,
  randomValue,
  sealToken,
  safeReturnPath,
} from "../services/onesaIdentity";
import { verifyPassword } from "../services/passwords";
import { rateLimit } from "../middleware/rateLimit";

import { exchangeNativeCode, nativeClient, nativeRedirect, nativeRequest } from "../services/nativeAuthorization";
import { accessIdentity, tokenProfile } from "../services/managedOnesa";

type VerifiedAccount = {
  iss: string; sub: string; email: string; name: string;
  onesa_product_roles: {logistics: "user" | "admin" | "administrator"};
  issuedAt?: number;
};

async function registrationAccount(identity: VerifiedAccount) {
  const {iss, sub, email, name, issuedAt} = identity;
  const role: VerifiedAccount["onesa_product_roles"]["logistics"] = identity.onesa_product_roles.logistics === "administrator" ? "admin" : identity.onesa_product_roles.logistics;
  // Conflicting local addresses require the existing proof-of-ownership flow.
  // A concurrent first sign-in can only create one row for this issuer and subject.
  await connection.query(
    `INSERT INTO users(onesa_issuer,onesa_subject,email,name,password,role,identity_managed_role,identity_role_issued_at)
     SELECT $1,$2,$3,$4,'!onesa-managed',$5,$6,$7
     WHERE NOT EXISTS(SELECT 1 FROM users WHERE onesa_issuer=$1 AND onesa_subject=$2) ON CONFLICT DO NOTHING`,
    [iss, sub, email.toLowerCase(), name, role, issuedAt === undefined ? null : role, issuedAt ?? null],
  );
  if (issuedAt !== undefined) {
    // An earlier signed token cannot reverse a newer decision. At the same
    // issuance second a downgrade wins. Local assignments have no managed role.
    await connection.query(
      `UPDATE users SET role=$3,identity_managed_role=$3,identity_role_issued_at=$4
       WHERE onesa_issuer=$1 AND onesa_subject=$2 AND NOT disabled AND identity_managed_role IS NOT NULL
       AND (identity_role_issued_at < $4 OR (identity_role_issued_at=$4 AND role='admin' AND $3='user'))`,
      [iss, sub, role, issuedAt],
    );
  }
  const {rows: [user]} = await connection.query(
    `SELECT id,role,active_workspace_id AS "activeWorkspaceId",session_version AS "sessionVersion",
            disabled,identity_managed_role AS "identityManagedRole"
     FROM users WHERE onesa_issuer=$1 AND onesa_subject=$2`, [iss, sub],
  );
  if (user?.identityManagedRole && (issuedAt === undefined || user.identityManagedRole !== role)) throw new InactiveIdentity();
  return user;
}

const router = Router();
router.get("/native/config", (_req, res) => {
  const config = identityConfig();
  const client = config?.managed && nativeClient(config.client);
  if (!config?.managed || !client) return res.sendStatus(503);
  return res.json({issuer: config.issuer, audience: config.managed.audience, client, redirect: nativeRedirect});
});
router.post("/native/exchange", rateLimit(15 * 60_000, 15), async (req, res) => {
  const input = nativeRequest.safeParse(req.body);
  if (!input.success) return res.sendStatus(400);
  try {
    const config = identityConfig();
    const client = config?.managed && nativeClient(config.client);
    if (!config?.managed || !client) return res.sendStatus(503);
    const tokens = await exchangeNativeCode(config.issuer, client, input.data);
    if (!tokens) return res.sendStatus(401);
    const identity = accessIdentity(config.issuer, client, tokens.access_token, config.managed);
    const profile = tokenProfile(config.issuer, client, tokens.id_token, input.data.nonce, identity.providerSubject, config.managed);
    const user = await registrationAccount({...identity, ...profile});
    if (!user || user.disabled || (user.role === "admin" && identity.onesa_product_roles.logistics !== "admin"))
      return res.sendStatus(403);
    const grant = JSON.stringify({nativeClient: client, token: tokens.access_token});
    return res.json({session: await createSession(user, sealToken(grant), config.issuer)});
  } catch (error) {
    return res.sendStatus(error instanceof InactiveIdentity ? 401 : 503);
  }
});
const transactionCookie = "__Host-onesa_logistics_login";
const returnCookie = "__Host-onesa_logistics_return";
const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
};
const localProof = z
  .object({
    email: z
      .email()
      .max(255)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();
router.get("/config", (_req, res) => {
  const config = identityConfig();
  return res.json({ enabled: Boolean(config), ...(config?.signup ? {signup:true} : {}) });
});
router.post("/start", rateLimit(15 * 60_000, 15), async (req, res) => {
  const config = identityConfig();
  if (!config)
    return res.status(503).json({ error: "Onesa sign-in is unavailable." });
  if (req.headers.origin !== config.origin) return res.sendStatus(403);
  const input = z
    .object({ link: localProof.optional(), returnTo: z.string().max(2048).optional(), signup:z.boolean().optional() })
    .strict()
    .safeParse(req.body);
  if (!input.success) return res.sendStatus(400);
  if (input.data.signup && (!config.signup || input.data.link)) return res.sendStatus(403);
  let localId: number | null = null,
    version: number | null = null;
  if (input.data.link) {
    const proof = input.data.link;
    const {
      rows: [user],
    } = await connection.query(
      "SELECT id,password,session_version FROM users WHERE email=$1 AND NOT disabled AND onesa_subject IS NULL",
      [proof.email],
    );
    if (!user || !(await verifyPassword(proof.password, user.password)))
      return res
        .status(401)
        .json({ error: "Could not confirm this local Logistics account." });
    localId = user.id;
    version = user.session_version;
  }
  const state = randomValue(),
    browser = randomValue(),
    verifier = randomValue();
  await connection.query(
    "DELETE FROM onesa_login_transactions WHERE expires_at<=now()",
  );
  await connection.query(
    "INSERT INTO onesa_login_transactions(state_hash,browser_hash,verifier,link_user_id,link_version) VALUES($1,$2,$3,$4,$5)",
    [digest(state), digest(browser), verifier, localId, version],
  );
  res.cookie(transactionCookie, browser, {
    ...cookieOptions,
    maxAge: 5 * 60_000,
  });
  res.cookie(returnCookie, safeReturnPath(input.data.returnTo), {
    ...cookieOptions, maxAge: 5 * 60_000,
  });
  return res.json({ url: authorizationUrl(config, state, verifier, input.data.signup) });
});

router.get("/callback", async (req, res) => {
  const config = identityConfig();
  if (!config) return res.sendStatus(503);
  res.setHeader("Referrer-Policy", "no-referrer");
  const retry = (reason: string, returnTo = "#/") => {
    const params = new URLSearchParams({ mode: "live", onesa: reason });
    if (returnTo !== "#/") params.set("returnTo", returnTo);
    return res.redirect(303, config.origin + "/#/login?" + params);
  };
  const query = z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code: z.string().min(1).max(4096).optional(),
      error: z.string().regex(/^[a-z_]{1,64}$/).optional(),
      iss: z.literal(config.issuer).optional(),
    })
    .refine(value => Boolean(value.code) !== Boolean(value.error))
    .safeParse(req.query);
  const browser = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(transactionCookie + "="))
    ?.split("=")[1];
  if (!query.success || !browser || !/^[A-Za-z0-9_-]{43}$/.test(browser))
    return retry("restart");
  let returnTo = "#/";
  try {
    const {
      rows: [txn],
    } = await connection.query(
      "DELETE FROM onesa_login_transactions WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *",
      [digest(query.data.state), digest(browser)],
    );
    if (!txn) return retry("restart");
    res.clearCookie(transactionCookie, cookieOptions);
    const encodedReturn = req.headers.cookie?.split(";").map(v => v.trim())
      .find(v => v.startsWith(returnCookie + "="))?.slice(returnCookie.length + 1);
    try { returnTo = safeReturnPath(decodeURIComponent(encodedReturn ?? "")); } catch {}
    res.clearCookie(returnCookie, cookieOptions);
    if (!query.data.code) {
      return retry(query.data.error === "access_denied" ? "cancelled" : "unavailable", returnTo);
    }
    const {token, identity} = await exchangeCode(config, query.data.code, txn.verifier);
    const email = identity.email.toLowerCase();
    if (txn.link_user_id !== null) {
      const updated = await connection.query(
        `UPDATE users SET onesa_issuer=$1,onesa_subject=$2 WHERE id=$3 AND email=$4 AND session_version=$5
         AND NOT disabled AND onesa_subject IS NULL`,
        [identity.iss, identity.sub, txn.link_user_id, email, txn.link_version],
      );
      if (!updated.rowCount) return retry("link", returnTo);
    }
    const user = await registrationAccount(identity);
    if (!user) return retry("link", returnTo);
    if (user.disabled || (user.role === "admin" && identity.onesa_product_roles.logistics !== "admin")) return retry("denied", returnTo);
    res.cookie(
      "imsop_access",
      await createSession(user, sealToken(token), config.issuer),
      authCookieOptions(),
    );
    return res.redirect(303, config.origin + "/" + returnTo);
  } catch (error) {
    return retry(error instanceof InactiveIdentity ? "denied" : "unavailable", returnTo);
  }
});
export default router;
