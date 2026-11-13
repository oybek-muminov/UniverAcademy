import {test} from "node:test";
import assert from "node:assert/strict";
import {clerkFixture,users,sids,issuer} from "./fixture.mjs";
import {signedInitData,ids} from "../backend/http-fixture.ts";

async function denyWithoutEffects(f,session,status=503){
  const before=f.snapshot(),seen=f.seen.length;
  const me=await f.call("GET","/me",undefined,session.access_token);
  const refresh=await f.call("POST","/auth/refresh",{refresh_token:session.refresh_token});
  assert.equal(me.status,status,JSON.stringify(me));assert.equal(refresh.status,status,JSON.stringify(refresh));
  assert.equal(refresh.json.data?.access_token,undefined);assert.equal(refresh.json.data?.refresh_token,undefined);
  assert.deepEqual(f.store.state,before);return{seen,afterSeen:f.seen.length};
}

test("F1: revoked Clerk session with deleted family binding never authenticates /me or issues refresh proofs",async()=>{
  const f=await clerkFixture();f.activate(users.student,sids.first);const session=(await f.exchange(await f.sign())).json.data;
  const familyId=Object.keys(f.store.state.familyBindings)[0];f.live.get(sids.first).status="revoked";
  await denyWithoutEffects(f,session,401); // Control: current provider revocation is checked.
  delete f.store.state.familyBindings[familyId];
  const calls=await denyWithoutEffects(f,session,503);
  assert.equal(f.store.state.domain.student.families[familyId].authProvider,"clerk");
  assert.equal(calls.afterSeen,calls.seen); // Missing metadata cannot turn into a provider-less path.
});

test("unknown/missing/conflicting family origin fails closed even for a Telegram-associated person with legacy login enabled",async()=>{
  const f=await clerkFixture({legacyTelegram:true});f.activate(users.student,sids.first);const session=(await f.exchange(await f.sign())).json.data;
  const familyId=Object.keys(f.store.state.familyBindings)[0];assert.ok(f.store.state.domain.student.people[ids.person].telegramId>0);
  for(const change of [
    s=>{delete s.domain.student.families[familyId].authProvider;},
    s=>{s.domain.student.families[familyId].authProvider="unknown";},
    s=>{s.domain.student.families[familyId].authProvider="telegram";},
    s=>{delete s.familyBindings[familyId];},
  ]){
    const saved=f.snapshot();change(f.store.state);await denyWithoutEffects(f,session);f.store.state=saved;
  }
});

test("explicit successful HMAC login stamps Telegram origin; missing marker/conflicting Clerk binding never inherits that origin",async()=>{
  const f=await clerkFixture({legacyTelegram:true}),telegramId=f.store.state.domain.student.people[ids.person].telegramId;
  const session=(await f.client.telegramLogin({init_data:signedInitData(telegramId,crypto.randomUUID(),f.store.time)})).data;
  const familyId=Object.keys(f.store.state.domain.student.families)[0];
  assert.equal(f.store.state.domain.student.families[familyId].authProvider,"telegram");assert.equal(Object.hasOwn(f.store.state.familyBindings,familyId),false);
  assert.equal((await f.client.me(session.access_token)).data.person_id,ids.person);
  const refreshed=(await f.client.refresh({refresh_token:session.refresh_token})).data;
  const current={...session,...refreshed};assert.equal((await f.client.me(current.access_token)).data.person_id,ids.person);
  for(const change of [
    s=>{delete s.domain.student.families[familyId].authProvider;},
    s=>{s.familyBindings[familyId]={issuer,userId:users.student,sessionId:sids.first};},
  ]){
    const saved=f.snapshot();change(f.store.state);await denyWithoutEffects(f,current);f.store.state=saved;
  }
  delete f.deps.legacyTelegram;await denyWithoutEffects(f,current);
});

test("recognized revoked-family logout ACK cannot repair missing binding, extend retention, revive old proof or revoke the new family",async()=>{
  const f=await clerkFixture();f.activate(users.student,sids.first);const old=(await f.exchange(await f.sign())).json.data;
  const oldFamily=Object.keys(f.store.state.familyBindings)[0];f.activate(users.student,sids.second);
  const current=(await f.exchange(await f.sign({sessionId:sids.second}))).json.data;
  delete f.store.state.familyBindings[oldFamily];const before=f.snapshot();
  assert.equal((await f.call("POST","/auth/logout",{refresh_token:old.refresh_token})).status,200);
  await denyWithoutEffects(f,old,401);assert.deepEqual(f.store.state,before);
  assert.equal((await f.client.me(current.access_token)).data.person_id,ids.person);
});

test("refresh guard follows its body proof despite invalid/unrelated bearer; logout never falls back from invalid bearer",async()=>{
  const f=await clerkFixture();f.activate(users.student,sids.first);const blocked=(await f.exchange(await f.sign())).json.data;
  const blockedFamily=Object.keys(f.store.state.familyBindings)[0];
  f.activate(users.other,sids.second);const other=(await f.exchange(await f.sign({userId:users.other,sessionId:sids.second}))).json.data;
  f.live.get(sids.first).status="revoked";
  for(const token of ["invalid-bearer",other.access_token]){
    const before=f.snapshot();const r=await f.call("POST","/auth/refresh",{refresh_token:blocked.refresh_token},token);
    assert.equal(r.status,401);assert.equal(r.json.data?.access_token,undefined);assert.deepEqual(f.store.state,before);
  }
  delete f.store.state.familyBindings[blockedFamily];
  for(const token of ["invalid-bearer",other.access_token]){
    const before=f.snapshot();const r=await f.call("POST","/auth/refresh",{refresh_token:blocked.refresh_token},token);
    assert.equal(r.status,503);assert.equal(r.json.data?.access_token,undefined);assert.deepEqual(f.store.state,before);
  }
  const before=f.snapshot();assert.equal((await f.call("POST","/auth/logout",{refresh_token:other.refresh_token},"invalid-bearer")).status,401);
  assert.deepEqual(f.store.state,before);await f.client.me(other.access_token);
});
