import {test} from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {randomUUID,generateKeyPairSync} from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../src/app";
import {connection} from "../src/config/db";
import {migrate} from "../src/migrate";

test("a linked Logistics operator can open an existing shipment with Docs absent and Identity offline",async t=>{
  const db=new URL(process.env.DATABASE_URL??"");
  assert.ok(["localhost","127.0.0.1"].includes(db.hostname)&&db.pathname.endsWith("_test"));
  const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const issuer="https://auth.onesa.eu/", legacy="https://portal.onesa.eu/api/v1/identity";
  const client="logistics-app-pilot", origin="https://logistics.example.test", audience="https://api.logistics.onesa.eu";
  const stable=randomUUID(), workspace=randomUUID(), other=randomUUID(), subject="auth0|synthetic";
  Object.assign(process.env,{ONESA_IDENTITY_ENABLED:"true",ONESA_IDENTITY_MODE:"managed",ONESA_IDENTITY_ISSUER:issuer,
    ONESA_IDENTITY_CLIENT_ID:client,ONESA_IDENTITY_CLIENT_SECRET:"s".repeat(48),ONESA_IDENTITY_AUDIENCE:audience,
    ONESA_IDENTITY_REDIRECT_URI:origin+"/api/auth/onesa/callback",CORS_ALLOWED_ORIGINS:origin,ALLOWED_ORIGIN:origin,
    ONESA_IDENTITY_JWKS:JSON.stringify({keys:[{...publicKey.export({format:"jwk"}),kid:"fixture"}]}),
    ONESA_IDENTITY_JWKS_EXPIRES_AT:String(Math.floor(Date.now()/1000)+3600)});
  await migrate();
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert(address&&typeof address==="object"); const base="http://127.0.0.1:"+address.port;
  const original=globalThis.fetch;
  t.after(async()=>{globalThis.fetch=original;await new Promise<void>(r=>server.close(()=>r()));await connection.end();});
  await connection.query("INSERT INTO workspaces(id,name) VALUES($1,'Assigned fixture'),($2,'Other fixture')",[workspace,other]);
  const user=(await connection.query("INSERT INTO users(email,password,name,role,active_workspace_id,onesa_issuer,onesa_subject) VALUES('pilot@example.test','!','Existing operator','engineer',$1,$2,$3) RETURNING id",[workspace,legacy,stable])).rows[0];
  await connection.query("INSERT INTO workspace_memberships(user_id,workspace_id) VALUES($1,$2)",[user.id,workspace]);
  const shipments=(await connection.query("INSERT INTO shipments(workspace_id,tracking_number,origin,destination,status) VALUES($1,$2,'A','B','delayed'),($3,$4,'C','D','delayed') RETURNING id",[workspace,randomUUID(),other,randomUUID()])).rows;
  let nonce="",online=true,role="user",products=["logistics"],aud=audience,expiry=180,nonceOverride="";
  const sign=(claims:object,audience:string,seconds:number)=>jwt.sign(claims,privateKey,{algorithm:"RS256",keyid:"fixture",issuer,subject,audience,expiresIn:seconds});
  globalThis.fetch=async(input,init)=>{
    if(String(input).startsWith(base+"/"))return original(input,init);
    if(String(input)!==issuer+"oauth/token")throw Error("Unexpected service dependency");
    if(!online)return Response.json({}, {status:503});
    const publicClient = (init?.body as URLSearchParams)?.get("client_id");
    const selected = publicClient || client;
    if (publicClient) {
      assert.equal(publicClient,process.env.ONESA_IDENTITY_NATIVE_CLIENT_ID);
      assert.equal((init?.body as URLSearchParams).get("redirect_uri"),"eu.onesa.logistics://signin/callback");
      assert.equal(new Headers(init?.headers).has("Authorization"),false);
    }
    return Response.json({token_type:"Bearer",access_token:sign({"https://onesa.eu/claims/user_id":stable,"https://onesa.eu/claims/products":products,
      "https://onesa.eu/claims/roles":[role],"https://onesa.eu/claims/mfa_time":Math.floor(Date.now()/1000),azp:selected},aud,expiry),
      id_token:sign({nonce:nonceOverride||nonce,email:"new-address@example.test",name:"New name",email_verified:true},selected,300)});
  };
  const get=(path:string,cookie="")=>fetch(base+path,{redirect:"manual",headers:{Origin:origin,Cookie:cookie}});
  const destination="#/supply-chain/shipments/"+shipments[0].id+"/tracking";
  const callback=async()=>{
    const started=await fetch(base+"/api/auth/onesa/start",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({returnTo:destination})});
    const url=new URL((await started.json()).url);
    assert.equal(url.origin+url.pathname,issuer+"authorize");assert.equal(url.searchParams.get("audience"),audience);
    assert.equal(url.searchParams.get("code_challenge_method"),"S256");nonce=url.searchParams.get("nonce")!;
    const cookies=started.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
    return get("/api/auth/onesa/callback?code=fixture&state="+url.searchParams.get("state"),cookies);
  };
  const signIn=async()=>{const cb=await callback();assert.equal(cb.headers.get("location"),origin+"/"+destination);return cb.headers.getSetCookie().find(v=>v.startsWith("imsop_access="))!.split(";")[0];};
  const session=await signIn();assert.equal((await (await get("/api/auth/me",session)).json()).user.id,String(user.id));
  const shipment="/api/operations/shipments/";
  assert.equal((await get(shipment+shipments[0].id,session)).status,200);
  assert.equal((await get(shipment+shipments[1].id,session)).status,404);
  process.env.ONESA_IDENTITY_NATIVE_CLIENT_ID="logistics-public-mobile";
  nonce="a".repeat(48);
  const nativeExchange=()=>fetch(base+"/api/auth/onesa/native/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"fixture",verifier:"v".repeat(64),nonce})});
  const native=await nativeExchange();assert.equal(native.status,200);
  const auth={Authorization:"Bearer "+(await native.json()).session};
  assert.equal((await fetch(base+shipment+shipments[0].id,{headers:auth})).status,200);
  assert.equal((await fetch(base+shipment+shipments[1].id,{headers:auth})).status,404);
  const review=(await connection.query("INSERT INTO review_cases(shipment_id,workspace_id) VALUES($1,$2) ON CONFLICT (workspace_id,shipment_id) DO UPDATE SET state='open' RETURNING id,version",[shipments[0].id,workspace])).rows[0];
  const path=base+"/api/operations/reviews/"+review.id;
  assert.equal((await fetch(path,{headers:auth})).status,200);
  const action=await fetch(path+"/actions",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({action:"resolve",version:review.version,note:"Delivery confirmed by fixture receiver"})});
  assert.equal(action.status,200);
  assert.equal((await (await fetch(path,{headers:auth})).json()).state,"resolved");
  assert.ok((await (await fetch(path+"/actions",{headers:auth})).json()).items.some((a:{action:string})=>a.action==="resolve"));
  nonceOverride="invalid";assert.equal((await nativeExchange()).status,401);nonceOverride="";
  role="admin";const staff=await signIn();assert.equal((await (await get("/api/auth/me",staff)).json()).user.role,"engineer");
  role="user";products=[];assert.match((await callback()).headers.get("location")!,/onesa=denied$/);
  products=["logistics"];aud="https://api.other.example";assert.match((await callback()).headers.get("location")!,/onesa=denied$/);aud=audience;
  nonceOverride="incorrect";assert.match((await callback()).headers.get("location")!,/onesa=denied$/);nonceOverride="";
  expiry=2;const short=await signIn();online=false;
  assert.equal((await get(shipment+shipments[0].id,session)).status,200);
  assert.match((await callback()).headers.get("location")!,/onesa=unavailable$/);
  await new Promise(r=>setTimeout(r,2100));assert.equal((await get(shipment+shipments[0].id,short)).status,401);
  assert.equal((await connection.query("SELECT count(*) FROM users WHERE onesa_subject=$1",[stable])).rows[0].count,"1");
});
