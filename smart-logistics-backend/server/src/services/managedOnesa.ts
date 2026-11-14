import {createPublicKey} from "node:crypto";
import jwt, {type JwtPayload} from "jsonwebtoken";
import {z} from "zod";

export class InactiveIdentity extends Error {}
const claim = "https://onesa.eu/claims/";
const rsaKey = z.object({
  kty:z.literal("RSA"),kid:z.string().min(1),n:z.string().min(1),e:z.string().min(1),
  use:z.literal("sig").optional(),alg:z.literal("RS256").optional(),d:z.never().optional(),
});

type TrustedSet = {keys:Map<string,ReturnType<typeof createPublicKey>>;audience:string;expires:number};
let cache: {source:string; audience:string; expires:number; value:TrustedSet} | undefined;

export function signingKeys(): TrustedSet {
  const audience=process.env.ONESA_IDENTITY_AUDIENCE;
  const expires=Number(process.env.ONESA_IDENTITY_JWKS_EXPIRES_AT);
  if(!audience || audience===process.env.ONESA_IDENTITY_CLIENT_ID || !Number.isSafeInteger(expires) || expires<=Date.now()/1000)
    throw Error("Missing Logistics audience or current signing-key snapshot");
  const source = process.env.ONESA_IDENTITY_JWKS ?? "{}";
  if (cache && cache.source === source && cache.audience === audience && cache.expires === expires) return cache.value;
  const set=z.object({keys:z.array(rsaKey).min(1).max(8)}).parse(JSON.parse(source));
  const keys=new Map(set.keys.map(key=>[key.kid,createPublicKey({key,format:"jwk"})]));
  if(keys.size!==set.keys.length)throw Error("Duplicate signing key");
  const value = {keys,audience,expires};
  cache = {source,audience,expires,value};
  return value;
}
type Keys=ReturnType<typeof signingKeys>;
export function verifyToken(token:string,issuer:string,audience:string,scope:Keys):JwtPayload {
  if(scope.expires<=Date.now()/1000)throw Error("Expired Identity signing-key snapshot");
  try {
    const header=jwt.decode(token,{complete:true})?.header;
    const key=header?.alg==="RS256" && header.kid ? scope.keys.get(header.kid) : undefined;
    if(!key)throw Error();
    const payload=jwt.verify(token,key,{algorithms:["RS256"],issuer,audience});
    if(typeof payload==="string" || !payload.sub || !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) || payload.exp!<=payload.iat! || payload.iat!>Date.now()/1000+5)throw Error();
    return payload;
  } catch {throw new InactiveIdentity();}
}

export function accessIdentity(issuer:string,client:string,token:string,scope:Keys) {
  const p=verifyToken(token,issuer,scope.audience,scope);
  const stable=z.uuid().safeParse(p[claim+"user_id"]);
  const products=z.array(z.string()).safeParse(p[claim+"products"]);
  const roles=z.array(z.string()).safeParse(p[claim+"roles"]);
  if(!stable.success || !products.success || !products.data.includes("logistics") || !roles.success ||
     !roles.data.some(role=>["user","admin"].includes(role)) || p.exp!-p.iat!>300 ||
     p.azp!==undefined && p.azp!==client)throw new InactiveIdentity();
  const admin=roles.data.includes("admin");
  const mfa=p[claim+"mfa_time"],now=Math.floor(Date.now()/1000);
  if(admin && (!Number.isSafeInteger(mfa) || mfa>now || now-mfa>=300))throw new InactiveIdentity();
  return {iss:"https://portal.onesa.eu/api/v1/identity",sub:stable.data,providerSubject:p.sub!,
    onesa_product_roles:{logistics:admin ? "admin" as const : "user" as const}};
}

export function tokenProfile(issuer:string,client:string,idToken:string,nonce:string,providerSubject:string,scope:Keys) {
  const p=verifyToken(idToken,issuer,client,scope);
  if(p.nonce!==nonce || p.sub!==providerSubject ||
     (Array.isArray(p.aud)&&p.aud.length>1 || p.azp!==undefined) && p.azp!==client)
    throw new InactiveIdentity();
  const profile=z.object({email:z.email().max(254),email_verified:z.literal(true),name:z.string().min(1).max(200).optional()}).safeParse(p);
  if(!profile.success)throw new InactiveIdentity();
  return {email:profile.data.email,name:profile.data.name??profile.data.email};
}
