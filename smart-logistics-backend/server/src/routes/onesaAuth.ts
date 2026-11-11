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
  liveIdentity,
  randomValue,
  sealToken,
  safeReturnPath,
} from "../services/onesaIdentity";
import { verifyPassword } from "../services/passwords";
import { rateLimit } from "../middleware/rateLimit";

const router = Router();
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
router.get("/config", (_req, res) =>
  res.json({ enabled: Boolean(identityConfig()) }),
);
router.post("/start", rateLimit(15 * 60_000, 15), async (req, res) => {
  const config = identityConfig();
  if (!config)
    return res.status(503).json({ error: "Onesa sign-in is unavailable." });
  if (req.headers.origin !== config.origin) return res.sendStatus(403);
  const input = z
    .object({ link: localProof.optional(), returnTo: z.string().max(2048).optional() })
    .strict()
    .safeParse(req.body);
  if (!input.success) return res.sendStatus(400);
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
  return res.json({ url: authorizationUrl(config, state, verifier) });
});

router.get("/callback", async (req, res) => {
  const config = identityConfig();
  if (!config) return res.sendStatus(503);
  res.setHeader("Referrer-Policy", "no-referrer");
  const retry = (reason: string) =>
    res.redirect(303, config.origin + "/#/login?mode=live&onesa=" + reason);
  const query = z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code: z.string().min(1).max(4096),
      iss: z.literal(config.issuer).optional(),
    })
    .safeParse(req.query);
  const browser = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(transactionCookie + "="))
    ?.split("=")[1];
  if (!query.success || !browser || !/^[A-Za-z0-9_-]{43}$/.test(browser))
    return retry("restart");
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
    let returnTo = "#/";
    try { returnTo = safeReturnPath(decodeURIComponent(encodedReturn ?? "")); } catch {}
    res.clearCookie(returnCookie, cookieOptions);
    const token = await exchangeCode(config, query.data.code, txn.verifier);
    const identity = await liveIdentity(config, token);
    const email = identity.email.toLowerCase();
    if (txn.link_user_id !== null) {
      const updated = await connection.query(
        `UPDATE users SET onesa_issuer=$1,onesa_subject=$2 WHERE id=$3 AND email=$4 AND session_version=$5
         AND NOT disabled AND onesa_subject IS NULL`,
        [identity.iss, identity.sub, txn.link_user_id, email, txn.link_version],
      );
      if (!updated.rowCount) return retry("link");
    }
    // Existing subjects authenticate by issuer and subject even if their central email changes.
    // Email collisions with local accounts require explicit proof of both accounts.
    const values = [identity.iss, identity.sub];
    const lookup = `SELECT id,role,active_workspace_id AS "activeWorkspaceId",session_version AS "sessionVersion",disabled
                    FROM users WHERE onesa_issuer=$1 AND onesa_subject=$2`;
    let {
      rows: [user],
    } = await connection.query(lookup, values);
    if (!user) {
      await connection.query(
        `INSERT INTO users(onesa_issuer,onesa_subject,email,name,password,role) VALUES($1,$2,$3,$4,'!onesa-managed',$5)
         ON CONFLICT DO NOTHING`,
        [...values, email, identity.name, identity.onesa_product_roles.logistics],
      );
      ({
        rows: [user],
      } = await connection.query(lookup, values));
    }
    if (!user) return retry("link");
    if (user.disabled || (user.role === "admin" && identity.onesa_product_roles.logistics !== "admin")) return retry("denied");
    res.cookie(
      "imsop_access",
      await createSession(user, sealToken(token)),
      authCookieOptions(),
    );
    return res.redirect(303, config.origin + "/" + returnTo);
  } catch (error) {
    return retry(error instanceof InactiveIdentity ? "denied" : "unavailable");
  }
});
export default router;
