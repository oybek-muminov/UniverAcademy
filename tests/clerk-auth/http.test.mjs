import {test} from "node:test";
import assert from "node:assert/strict";
import {clerkFixture,users,sids,issuer} from "./fixture.mjs";
import {clerkIdentityKey} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {ids,id,signedInitData} from "../backend/http-fixture.ts";
import {staffIds,versionBody,validate} from "../backend/staff-fixture.ts";

test("fresh Clerk account is a new UUID student with no Telegram/group/grant/staff rights; JWT/email/name never auto-merges",async()=>{
  const f=await clerkFixture({fresh:true});f.activate(users.student,sids.first);
  const token=await f.sign({claims:{roles:["owner"],o:{rol:"admin"},email:"same-as-someone@example.com",name:"Claimed owner"}}),r=await f.exchange(token);
  assert.equal(r.status,200,JSON.stringify(r));const session=r.json.data,p=session.profile;
  assert.ok(validate("SuccessSession",r.json));assert.match(p.person_id,/^[0-9a-f-]{36}$/);assert.match(p.qadam_id,/^\d{10}$/);
  assert.deepEqual(p.roles,["student"]);assert.equal(p.registration_complete,false);assert.equal(p.active_group_id,null);assert.equal(p.first_name,"");
  assert.equal(f.store.state.domain.student.people[p.person_id].telegramId,null);assert.deepEqual(f.store.state.domain.staff,{});
  assert.deepEqual((await f.client.exams(session.access_token)).data,[]);
  assert.equal((await f.client.updateProfile(session.access_token,{first_name:"Clerk",last_name:"Sintetik"})).data.registration_complete,true);
  f.activate(users.other,sids.second);const other=await f.exchange(await f.sign({userId:users.other,sessionId:sids.second,claims:{email:"same-as-someone@example.com"}}));
  assert.equal(other.status,200);assert.notEqual(other.json.data.profile.person_id,p.person_id);
  const text=JSON.stringify(f.store.state,(_,v)=>typeof v==="bigint"?v.toString():v);
  for(const secret of [token,session.access_token,session.refresh_token])assert.ok(!text.includes(secret));
  assert.equal(f.store.events.filter(e=>e==="commit").length,4);
});

test("existing mapping preserves the same account, answers/revisions/deadline; new Clerk session supersedes only the old student family",async()=>{
  const f=await clerkFixture();f.activate(users.student,sids.first);const a=(await f.exchange(await f.sign())).json.data;
  assert.equal(a.profile.person_id,ids.person);
  const attempt=(await f.client.startAttempt(a.access_token,ids.assignment,{confirmed:true},"clerk-start-existing")).data;
  const q=attempt.questions[0],chosen=q.options[0].id;
  assert.equal((await f.client.saveAnswer(a.access_token,attempt.id,q.id,{selected_option_id:chosen,expected_revision:0})).data.revision,1);
  const pinned=structuredClone(f.store.state.domain.student.attempts[attempt.id]);
  f.activate(users.student,sids.second);const b=(await f.exchange(await f.sign({sessionId:sids.second}))).json.data;
  assert.equal(b.profile.person_id,ids.person);await assert.rejects(f.client.me(a.access_token),e=>e.status===401);
  f.resetHandler();const resumed=(await f.client.resumeAttempt(b.access_token,attempt.id)).data;
  assert.equal(resumed.deadline_at,attempt.deadline_at);assert.equal(resumed.answers[0].revision,1);assert.equal(resumed.answers[0].selected_option_id,chosen);
  assert.deepEqual(f.store.state.domain.student.attempts[attempt.id],pinned);
  assert.equal(Object.values(f.store.state.domain.student.families).filter(x=>x.personId===ids.person&&x.revokedAt===null).length,1);
  const before=f.snapshot();assert.equal((await f.exchange(await f.sign({sessionId:sids.first}))).json.error.code,"CLERK_SESSION_SUPERSEDED");assert.deepEqual(f.store.state,before);
  assert.equal((await f.call("POST","/auth/refresh",{refresh_token:a.refresh_token})).status,401);
  assert.deepEqual((await f.client.me(b.access_token)).data.person_id,ids.person);
  // Recognizable revoked-family body-only logout can ACK within its tombstone;
  // it cannot activate that family, extend retention or revoke the new one.
  const revoked=f.snapshot();assert.equal((await f.call("POST","/auth/logout",{refresh_token:a.refresh_token})).status,200);assert.deepEqual(f.store.state,revoked);
  assert.equal((await f.call("POST","/auth/logout",{refresh_token:b.refresh_token},"invalid-bearer")).status,401);
  await f.client.me(b.access_token);
});

test("invalid/expired/disabled/revoked login does not consume proof, create account or disturb an active family",async()=>{
  const f=await clerkFixture();f.activate(users.student,sids.first);const old=(await f.exchange(await f.sign())).json.data;
  const good=await f.sign(),before=f.snapshot();assert.equal((await f.exchange(good.slice(0,-10)+"aaaaaaaaaa")).status,401);assert.deepEqual(f.store.state,before);
  f.store.beforeWork=async()=>{f.store.time+=61000;};const queued=await f.sign();assert.equal((await f.exchange(queued)).status,401);assert.deepEqual(f.store.state,before);f.store.time-=61000;
  for(const change of [()=>{f.live.get(sids.first).status="revoked";},()=>{f.store.state.domain.student.people[ids.person].enabled=false;},
    ()=>{f.store.state.identities[clerkIdentityKey({issuer,userId:users.student})].enabled=false;}]){
    const saved=f.snapshot(),live=structuredClone(f.live.get(sids.first));change();const disabled=f.snapshot();
    assert.ok([401,403].includes((await f.exchange(await f.sign())).status));assert.deepEqual(f.store.state,disabled);f.store.state=saved;f.live.set(sids.first,live);
  }
  await f.client.me(old.access_token);
});

test("JWT exchange replay is one-use; concurrent first logins serialize to one canonical account and one active app family",async()=>{
  const f=await clerkFixture({fresh:true});f.activate(users.student,sids.first);const jti=crypto.randomUUID(),token=await f.sign({claims:{jti}});
  const same=await Promise.all([f.exchange(token),f.exchange(token)]);assert.deepEqual(same.map(r=>r.status).sort(),[200,409]);
  assert.equal(Object.keys(f.store.state.domain.student.people).length,1);
  assert.equal((await f.exchange(await f.sign({claims:{jti},headers:{noncritical_marker:"same-proof-re-signed"}}))).json.error.code,"CLERK_TOKEN_REPLAY");
  f.activate(users.student,sids.second);const outcomes=await Promise.all([f.exchange(await f.sign({sessionId:sids.first})),f.exchange(await f.sign({sessionId:sids.second}))]);
  assert.ok(outcomes.some(x=>x.status===200));assert.equal(Object.keys(f.store.state.domain.student.people).length,1);
  assert.equal(Object.values(f.store.state.domain.student.families).filter(x=>x.revokedAt===null).length,1);
});

test("provider/session binding and current liveness guard opaque access and refresh; outages never grant offline access",async()=>{
  const f=await clerkFixture();f.activate(users.student,sids.first);const a=(await f.exchange(await f.sign())).json.data;
  for(const change of [{status:"revoked"},{userId:users.other},{accountEnabled:false}]){
    const live=structuredClone(f.live.get(sids.first));Object.assign(f.live.get(sids.first),change);const before=f.snapshot();
    await assert.rejects(f.client.me(a.access_token),e=>e.status===401);
    assert.equal((await f.call("POST","/auth/refresh",{refresh_token:a.refresh_token})).status,401);assert.deepEqual(f.store.state,before);f.live.set(sids.first,live);
  }
  const live=f.deps.liveness;f.deps.liveness=async()=>{throw Error("synthetic outage");};const before=f.snapshot();
  await assert.rejects(f.client.me(a.access_token),e=>e.status===503);assert.deepEqual(f.store.state,before);f.deps.liveness=live;
  const refreshed=await f.client.refresh({refresh_token:a.refresh_token});await f.client.me(refreshed.data.access_token);
});

test("unknown exchange COMMIT is not ACKed; a fresh JWT for the still-current session recovers without a second account",async()=>{
  for(const failure of ["before","after"]){
    const f=await clerkFixture({fresh:true});f.activate(users.student,sids.first);const token=await f.sign();f.store.failCommit=failure;
    assert.equal((await f.exchange(token)).status,503);assert.equal(Object.keys(f.store.state.domain.student.people).length,failure==="after"?1:0);
    const r=await f.exchange(await f.sign());assert.equal(r.status,200);assert.equal(Object.keys(f.store.state.domain.student.people).length,1);
    assert.equal(Object.values(f.store.state.domain.student.families).filter(x=>x.revokedAt===null).length,1);
  }
});

test("Telegram link remains authenticated but blocked; optional existing Telegram association never auto-links or lets old Clerk session reclaim",async()=>{
  const f=await clerkFixture({legacyTelegram:true});f.activate(users.student,sids.first);const token=await f.sign();
  const a=await f.exchange(token);assert.equal(a.status,200);const before=f.snapshot();
  const blocked=await f.call("POST","/auth/telegram/link",{init_data:"synthetic-unconsumed-proof"},await f.sign());
  assert.equal(blocked.status,409);assert.equal(blocked.json.error.code,"IDENTITY_LINK_POLICY_UNRESOLVED");assert.deepEqual(f.store.state,before);
  assert.equal((await f.exchange(await f.sign(),{person_id:ids.person})).status,422);assert.deepEqual(f.store.state,before);
  const person=f.store.state.domain.student.people[ids.person],raw=signedInitData(person.telegramId,crypto.randomUUID(),f.store.time);
  const telegram=(await f.client.telegramLogin({init_data:raw})).data;assert.equal(telegram.profile.person_id,ids.person);
  assert.equal((await f.exchange(await f.sign())).json.error.code,"CLERK_SESSION_SUPERSEDED");
  await f.client.me(telegram.access_token);
  const fresh=await clerkFixture({fresh:true});fresh.activate(users.student,sids.first);
  const login=(await fresh.exchange(await fresh.sign())).json.data;assert.equal(fresh.store.state.domain.student.people[login.profile.person_id].telegramId,null);
  assert.equal((await fresh.call("POST","/auth/telegram",{init_data:raw})).status,503);
});

test("approved parallel staff policy permits a valid Admin while student/claim/cached owner authority cannot become staff",async()=>{
  const f=await clerkFixture();f.activate(users.admin,sids.admin);const before=f.snapshot();
  const admin=await f.sign({userId:users.admin,sessionId:sids.admin});
  const allowed=await f.call("PATCH",`/admin/versions/${staffIds.draft}`,versionBody(),admin,{"idempotency-key":"clerk-admin-draft"});
  assert.equal(allowed.status,200);assert.deepEqual(f.store.state.studentSessions,before.studentSessions);
  f.activate(users.student,sids.first);f.store.state.domain.staff[users.student]={...structuredClone(f.store.state.domain.staff[users.admin]),personId:ids.person,roles:["owner"]};
  const poisoned=f.snapshot(),forged=await f.sign({claims:{role:"owner",o:{rol:"admin",per:"*"}}});
  assert.equal((await f.call("PATCH",`/admin/versions/${staffIds.draft}`,versionBody(),forged,{"idempotency-key":"clerk-student-forge"})).status,403);assert.deepEqual(f.store.state,poisoned);
});

test("parallel staff sessions retain current scope/capabilities and immutable receipts; revocation defeats old JWT replay",async()=>{
  const f=await clerkFixture();f.activate(users.admin,sids.admin);const token=await f.sign({userId:users.admin,sessionId:sids.admin});
  const call=()=>f.call("PATCH",`/admin/versions/${staffIds.draft}`,versionBody(),token,{"idempotency-key":"clerk-current-admin"});
  const first=await call();assert.equal(first.status,200,JSON.stringify(first));assert.deepEqual(await call(),first);
  for(const [change,status]of [
    [()=>{f.store.state.domain.staff[users.admin].capabilities.manage_content=false;},404],
    [()=>{f.store.state.domain.staff[users.admin].scope.subject_ids=[];},404],
    [()=>{f.store.state.domain.staff[users.admin].approved=false;},403],
    [()=>{f.store.state.domain.staff[users.admin].enabled=false;},403],
    [()=>{f.store.state.domain.student.people[staffIds.admin].profile.roles=["student"];},403],
    [()=>{f.store.state.identities[clerkIdentityKey({issuer,userId:users.admin})].enabled=false;},401]]){
    const saved=f.snapshot();change();const before=f.snapshot();assert.equal((await call()).status,status);assert.deepEqual(f.store.state,before);f.store.state=saved;
  }
  f.live.get(sids.admin).status="revoked";assert.equal((await call()).status,401);
  assert.equal(f.store.state.domain.audit.length,1);
});
