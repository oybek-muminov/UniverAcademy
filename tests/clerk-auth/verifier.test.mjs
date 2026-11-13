import {test} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPair} from "jose";
import {createClerkVerifier,requireLiveClerk} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {createStaffJwtVerifier} from "../../supabase/functions/univeracademy-api/staff-jwt.ts";
import {clerkFixture,issuer,uiOrigin,users,sids} from "./fixture.mjs";

test("Clerk v2 RS256 proof preserves user_/sess_ case and never projects JWT/organization roles into authority",async()=>{
  const f=await clerkFixture(),token=await f.sign({claims:{role:"owner",roles:["owner"],o:{rol:"admin",per:"*"},email:"synthetic@example.com"}});
  const proof=await createClerkVerifier(f.verifier)(token);
  assert.equal(proof.userId,users.student);assert.equal(proof.sessionId,sids.first);assert.equal(proof.kind,"clerk_verified");
  assert.equal(Object.isFrozen(proof),true);assert.deepEqual(Object.keys(proof).sort(),["authorizedParty","expiresAt","issuer","kind","notBefore","sessionId","tokenId","userId"]);
  assert.notEqual(proof.userId,proof.userId.toLowerCase());
});
test("malformed/wrong provider identifiers, version, dates, status, authorized party and impersonation fail closed",async()=>{
  const f=await clerkFixture(),verify=createClerkVerifier(f.verifier),seconds=Math.floor(f.store.time/1000);
  for(const claims of [{sub:"00000000-0000-4000-8000-000000000001"},{sub:"user_"},{sub:"user_X\n"},{sub:"user_X/other"},
    {sid:"sess_"},{sid:"sess_X\n"},{sid:"session_X"},{v:1},{v:undefined},{azp:undefined},{azp:"https://foreign.example.com"},
    {jti:""},{exp:seconds},{nbf:seconds+1},{iat:seconds+1},{exp:seconds-1},{nbf:undefined},{iat:1.5},{sts:"pending"},{sts:"revoked"},{act:{sub:users.admin}},{iss:"https://foreign.example.com"}]){
    await assert.rejects(verify(await f.sign({claims})),e=>e.status===401&&e.code==="CLERK_TOKEN_INVALID",JSON.stringify(claims));
  }
  const token=await f.sign();await assert.rejects(verify(token.slice(0,-8)+"aaaaaaaa"),e=>e.status===401);
});
test("algorithm/key/audience profile is explicit; unknown-key failure differs from trusted resolver availability",async()=>{
  const f=await clerkFixture(),verify=createClerkVerifier(f.verifier),other=await generateKeyPair("RS256",{modulusLength:2048});
  await assert.rejects(verify(await f.sign({privateKey:other.privateKey})),e=>e.status===401);
  await assert.rejects(verify(await f.sign({algorithm:"HS256",privateKey:new Uint8Array(32)})),e=>e.status===401);
  await assert.rejects(verify(await f.sign({claims:{aud:"another-api"}})),e=>e.status===401);
  const required=createClerkVerifier({...f.verifier,audience:{kind:"required",value:"qadam-api"}});
  await assert.rejects(required(await f.sign()),e=>e.status===401);await required(await f.sign({claims:{aud:"qadam-api"}}));
  const unavailable=createClerkVerifier({...f.verifier,trustedKeys:async()=>{throw Error("synthetic resolver outage");}});
  await assert.rejects(unavailable(await f.sign()),e=>e.status===503);
  for(const change of [{issuer:"http://clerk.example.com"},{authorizedParties:[]},{audience:undefined},{trustedKeys:undefined}])
    assert.throws(()=>createClerkVerifier({...f.verifier,...change}),e=>e.status===503);
});
test("current provider session/account tuple and expiry must match; status/outage never becomes authentication",async()=>{
  const f=await clerkFixture(),id={issuer,userId:users.student,sessionId:sids.first};f.activate(id.userId,id.sessionId);
  await requireLiveClerk(id,f.store.time,f.deps.liveness);
  for(const change of [{status:"pending"},{status:"revoked"},{userId:users.other},{sessionId:sids.second},{issuer:"https://foreign.example.com"},{accountEnabled:false},{expiresAt:f.store.time}]){
    const base=f.live.get(sids.first);f.live.set(sids.first,{...base,...change});
    await assert.rejects(requireLiveClerk(id,f.store.time,f.deps.liveness),e=>e.status===401);f.live.set(sids.first,base);
  }
  await assert.rejects(requireLiveClerk(id,f.store.time,async()=>{throw Error("synthetic outage");}),e=>e.status===503);
});
test("existing UUID staff verifier stays strict and rejects Clerk IDs even with its authenticated role claim",async()=>{
  const f=await clerkFixture(),old=createStaffJwtVerifier({issuer,audience:"authenticated",algorithms:["RS256"],trustedKeys:f.verifier.trustedKeys,now:f.verifier.now});
  await assert.rejects(old(await f.sign({claims:{role:"authenticated",aud:"authenticated",session_id:sids.first}})),e=>e.status===401&&e.code==="STAFF_TOKEN_INVALID");
});
