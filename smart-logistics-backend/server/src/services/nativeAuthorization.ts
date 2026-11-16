import { z } from "zod";

// The public client registration belongs to this installed product. The provider
// binds each code to both this exact redirect and the device's PKCE challenge.
export const nativeRequest = z.object({
  code: z.string().min(1).max(4096),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
}).strict();
export const nativeRedirect = "eu.onesa.logistics://signin/callback";
export function nativeClient(webClient: string) {
  const client = process.env.ONESA_IDENTITY_NATIVE_CLIENT_ID || "";
  return /^[A-Za-z0-9_-]{16,128}$/.test(client) && client !== webClient ? client : null;
}

export async function exchangeNativeCode(issuer: string, client: string, request: z.infer<typeof nativeRequest>) {
  const reply = await fetch(new URL("oauth/token", issuer), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: client, redirect_uri: nativeRedirect,
      code: request.code, code_verifier: request.verifier,
    }),
  });
  if ([400, 401, 403].includes(reply.status)) return null;
  if (!reply.ok) throw new Error("Identity token service unavailable");
  return z.object({ token_type: z.string().regex(/^bearer$/i),
    access_token: z.string().min(20).max(12000), id_token: z.string().min(20).max(12000),
  }).parse(await reply.json());
}
