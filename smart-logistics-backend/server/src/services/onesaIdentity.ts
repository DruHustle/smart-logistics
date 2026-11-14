import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { getAllowedOrigins, getJwtSecret } from "../config/security";

import {accessIdentity, InactiveIdentity, signingKeys, tokenProfile} from "./managedOnesa";
export {InactiveIdentity} from "./managedOnesa";

type Config = {issuer:string;client:string;secret:string;origin:string;redirect:string;managed?:ReturnType<typeof signingKeys>};
const callbackPath = "/api/auth/onesa/callback";
export const randomValue = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

export function identityConfig():Config|null {
  if (process.env.ONESA_IDENTITY_ENABLED !== "true") return null;
  const issuer = process.env.ONESA_IDENTITY_ISSUER || "";
  const client = process.env.ONESA_IDENTITY_CLIENT_ID || "";
  const secret = process.env.ONESA_IDENTITY_CLIENT_SECRET || "";
  const redirect = process.env.ONESA_IDENTITY_REDIRECT_URI || "";
  const origin = new URL(redirect).origin;
  const authority = new URL(issuer);
  const mode = process.env.ONESA_IDENTITY_MODE || "portal";
  if (mode !== "portal" && mode !== "managed") throw Error("Invalid Onesa Identity mode");
  const managed = mode==="managed" ? signingKeys() : undefined;
  if (
    authority.protocol !== "https:" ||
    (managed ? issuer !== "https://auth.onesa.eu/" : issuer !== authority.origin + "/api/v1/identity") ||
    !getAllowedOrigins().includes(origin) ||
    !redirect.startsWith("https://") ||
    redirect !== origin + callbackPath ||
    !/^[\w-]{16,128}$/.test(client) ||
    secret.length < 48 ||
    secret.length > 256
  )
    throw Error("Invalid Onesa configuration");
  return { issuer, client, secret, redirect, origin, managed };
}
// The PKCE secret is unique per login; a separate derivation binds the ID token to that transaction.
const transactionNonce = (verifier:string) => digest("logistics-oidc-nonce:" + verifier);

export function authorizationUrl(
  config: Config,
  state: string,
  verifier: string,
) {
  const params = new URLSearchParams({
    response_type: "code",
    scope: config.managed ? "openid email profile" : "openid email profile onesa",
    ...(config.managed && {audience:config.managed.audience}),
    client_id: config.client,
    redirect_uri: config.redirect,
    state,
    nonce: transactionNonce(verifier),
    code_challenge: digest(verifier),
    code_challenge_method: "S256",
  });
  return config.issuer + (config.managed ? "authorize?" : "/auth?") + params;
}

const encoded = (value: string) =>
  new URLSearchParams({ x: value }).toString().slice(2);
async function issuerPost(
  config: Config,
  path: "/token" | "/session" | "oauth/token",
  body: URLSearchParams | string,
) {
  const credentials = Buffer.from(
    encoded(config.client) + ":" + encoded(config.secret),
  ).toString("base64");
  const response = await fetch(config.issuer + path, {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: "Basic " + credentials,
      Accept: "application/json",
      "Content-Type":
        typeof body === "string"
          ? "application/json"
          : "application/x-www-form-urlencoded",
    },
  });
  if ([400, 401, 403].includes(response.status)) throw new InactiveIdentity();
  if (!response.ok) throw Error("Onesa identity unavailable");
  return response.json() as Promise<unknown>;
}

export async function exchangeCode(
  config: Config,
  code: string,
  verifier: string,
) {
  const response = z
    .object({
      access_token: z.string().min(20).max(16384),
      id_token: z.string().max(16384).optional(),
      token_type: z.string().regex(/^Bearer$/i),
    })
    .parse(
      await issuerPost(
        config,
        config.managed ? "oauth/token" : "/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirect,
          code_verifier: verifier,
        }),
      ),
    );
  if (config.managed) {
    if (!response.id_token) throw new InactiveIdentity();
    const claims = accessIdentity(config.issuer,config.client,response.access_token,config.managed);
    const profile = tokenProfile(config.issuer,config.client,response.id_token,transactionNonce(verifier),claims.providerSubject,config.managed);
    return {token:response.access_token, identity:{...claims,...profile}};
  }
  return {token:response.access_token, identity:await legacyIdentity(config,response.access_token)};
}
const assertion = z.object({
  active: z.literal(true),
  iss: z.string(),
  aud: z.string(),
  sub: z.uuid(),
  email: z.email().max(254),
  email_verified: z.literal(true),
  name: z.string().min(1).max(200),
  exp: z.number().int(),
  auth_time: z.number().int().positive(),
  amr: z.array(z.string()),
  onesa_roles: z.array(z.string()),
  onesa_applications: z.array(z.string()),
  onesa_product_roles: z.object({ logistics: z.enum(["user", "admin"]) }),
});
export function liveIdentity(config:Config,token:string) {
  return config.managed ? Promise.resolve(accessIdentity(config.issuer,config.client,token,config.managed)) : legacyIdentity(config,token);
}
async function legacyIdentity(config: Config, token: string) {
  const result = assertion.safeParse(
    await issuerPost(config, "/session", JSON.stringify({ token })),
  );
  if (!result.success) throw new InactiveIdentity();
  const a = result.data,
    now = Math.floor(Date.now() / 1000);
  if (
    a.iss !== config.issuer ||
    a.aud !== config.client ||
    a.exp <= now || a.exp > now + 86400 ||
    a.auth_time > now ||
    now - a.auth_time >= 28800 ||
    !a.onesa_applications.includes("logistics") ||
    a.onesa_roles.includes("global_admin") !== (a.onesa_product_roles.logistics === "admin") ||
    (a.onesa_product_roles.logistics === "admin" && !a.amr.some((v) => v === "otp" || v === "mfa"))
  )
    throw new InactiveIdentity();
  return a;
}

// A return destination is navigation only; workspace/object access is checked separately.
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 ||
      !/^#\/(?!\/)/.test(value) || /[\\\u0000-\u0020\u007f]/.test(value) ||
      /^#\/(?:login|register|reset-password|forgot-password)(?:[/?#]|$)/.test(value)) return "#/";
  return value;
}

function storageKey() {
  return createHmac("sha256", getJwtSecret())
    .update("smart-logistics:onesa-session:v1")
    .digest();
}
export function sealToken(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", storageKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function openToken(value: string) {
  const data = Buffer.from(value, "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    storageKey(),
    data.subarray(0, 12),
  );
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    cipher.update(data.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
