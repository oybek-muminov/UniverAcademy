import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, errors } from "jose";
import { createStaffJwtVerifier, requireLiveStaff } from "../../supabase/functions/univeracademy-api/staff-jwt.ts";
const id=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const subject=id(700),person=id(501),session=id(701),issuer="https://synthetic.invalid/auth/v1";
const keys=await generateKeyPair("ES256"),pub=await exportJWK(keys.publicKey);pub.kid="synthetic-1";
const trustedKeys=createLocalJWKSet({keys:[pub]});
const config={issuer,audience:"authenticated",algorithms:["ES256"],trustedKeys,now:()=>100000};
async function token(claims={},privateKey=keys.privateKey,header={alg:"ES256",kid:"synthetic-1"}) {
  return new SignJWT({iss:issuer,aud:"authenticated",sub:subject,session_id:session,iat:90,exp:200,
    role:"authenticated",...claims}).setProtectedHeader(header).sign(privateKey);
}
const state=()=>({staff:{[subject]:{personId:person,enabled:true,approved:true,roles:["admin"],approvedSubjectIds:[],
  capabilities:{manage_content:false,manage_roster:false},scope:{all_groups:false,group_ids:[],all_subjects:false,subject_ids:[]}}}});
const tx={personIds:[person],now:100000};
test("real ES256 signature and exact issuer/audience produce only identity/time/session proof, ignoring forged application roles",async()=>{
  const proof=await createStaffJwtVerifier(config)(await token({user_metadata:{roles:["owner"]},app_metadata:{roles:["owner"]}}));
  assert.deepEqual(proof,{kind:"staff_verified",subject,issuer,providerSessionId:session,notBefore:90000,expiresAt:200000});
  const principal=await requireLiveStaff(tx,proof,state(),async()=>true);
  assert.deepEqual(principal.roles,["admin"]);assert.equal(principal.capabilities.manage_content,false);
});
test("wrong signature, issuer, audience, absent session, anonymous and service-role tokens fail closed",async()=>{
  const bad=await generateKeyPair("ES256");
  for(const t of [await token({},bad.privateKey),await token({iss:"https://other.invalid/auth/v1"}),
    await token({aud:"other"}),await token({session_id:undefined}),await token({is_anonymous:true}),
    await token({role:"service_role"}),"synthetic-admin-proof","eyJbroken"])
    await assert.rejects(createStaffJwtVerifier(config)(t),e=>e.code==="STAFF_TOKEN_INVALID");
});
test("expiry equality, future iat/nbf, fractional NumericDate and disallowed algorithm are rejected",async()=>{
  for(const claims of [{exp:100},{iat:101},{nbf:101},{iat:90.5},{exp:200.5},{session_id:"bad-id"}])
    await assert.rejects(createStaffJwtVerifier(config)(await token(claims)),e=>e.code==="STAFF_TOKEN_INVALID");
  const hs=await new SignJWT({iss:issuer,aud:"authenticated",sub:subject,session_id:session,iat:90,exp:200,role:"authenticated"})
    .setProtectedHeader({alg:"HS256"}).sign(new TextEncoder().encode("only-synthetic-test-key-with-32-bytes"));
  await assert.rejects(createStaffJwtVerifier(config)(hs),e=>e.code==="STAFF_TOKEN_INVALID");
});
test("current disabled/unapproved staff, expired post-lock proof and absent/revoked provider session cannot use a signed token",async()=>{
  const proof=await createStaffJwtVerifier(config)(await token());
  for(const [change,code] of [[s=>{s.staff[subject].enabled=false;},"ACCOUNT_DISABLED"],
    [s=>{s.staff[subject].approved=false;},"STAFF_NOT_APPROVED"],[s=>{delete s.staff[subject];},"STAFF_TOKEN_INVALID"]]){
    const s=state();change(s);await assert.rejects(requireLiveStaff(tx,proof,s,async()=>true),e=>e.code===code);
  }
  await assert.rejects(requireLiveStaff({...tx,now:200000},proof,state(),async()=>true),e=>e.code==="STAFF_TOKEN_INVALID");
  await assert.rejects(requireLiveStaff(tx,proof,state(),async()=>false),e=>e.code==="STAFF_TOKEN_INVALID");
  await assert.rejects(requireLiveStaff(tx,proof,state(),undefined),e=>e.code==="SERVICE_UNAVAILABLE");
  await assert.rejects(requireLiveStaff({...tx,personIds:[]},proof,state(),async()=>true),e=>e.code==="NOT_FOUND");
});
test("trusted key/session source outage is availability failure; incoming jku cannot choose a provider endpoint",async()=>{
  const raw=await token({},keys.privateKey,{alg:"ES256",kid:"synthetic-1",jku:"https://attacker.invalid/keys"});
  assert.equal((await createStaffJwtVerifier(config)(raw)).subject,subject); // local trusted key set only
  await assert.rejects(createStaffJwtVerifier({...config,trustedKeys:async()=>{throw Error("synthetic outage");}})(raw),e=>e.code==="SERVICE_UNAVAILABLE");
  for(const error of [new errors.JWKSTimeout(),new errors.JWKSInvalid(),new errors.JWKInvalid()])
    await assert.rejects(createStaffJwtVerifier({...config,trustedKeys:async()=>{throw error;}})(raw),e=>e.code==="SERVICE_UNAVAILABLE");
  const proof=await createStaffJwtVerifier(config)(raw);
  await assert.rejects(requireLiveStaff(tx,proof,state(),async()=>{throw Error("synthetic outage");}),e=>e.code==="SERVICE_UNAVAILABLE");
});
