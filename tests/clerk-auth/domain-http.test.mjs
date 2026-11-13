import {test} from "node:test";
import assert from "node:assert/strict";
import {createConfiguredHttpHandler} from "../../supabase/functions/univeracademy-api/configured-http.ts";
import {SessionRows} from "../../supabase/functions/univeracademy-api/storage/session-rows.ts";
import {PostgresTransactions} from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";
import {proofHash} from "../../supabase/functions/univeracademy-api/student-state.ts";
import {durableWrite} from "../storage-auth/disk-executor.mjs";
import {domainExecutor} from "./domain-executor.mjs";
import {firstTestFixture} from "../first-test/fixture.mjs";
import {clerkFixture,users,sids,issuer} from "./fixture.mjs";
import {testPolicy,testNumbers,botKey,signedInitData} from "../backend/http-fixture.ts";
import {validate} from "../backend/staff-fixture.ts";

async function fixture(t){
  const f=await firstTestFixture(t);let pool=domainExecutor(f.path);pool.now=f.pool.now;
  const crypt=await clerkFixture({fresh:true,now:()=>pool.now});let live=true,provider;
  const d=pool.read();d.clerkIdentities={};d.clerkBindings={};d.clerkFences={};d.clerkReplays={};
  for(const [uid,personId]of [[users.student,f.student.profile.person_id],[users.admin,f.actors.admin.person],[users.teacher,f.actors.teacher.person]])d.clerkIdentities[JSON.stringify([issuer,uid])]={personId,enabled:true};
  durableWrite(f.path,d);
  const config=()=>({mode:"local_contract",storage:{kind:"postgres_contract_double",pool},botToken:botKey,sessionPolicy:{...testPolicy,familyTtlMs:3600000},numericPresentation:testNumbers,now:()=>pool.now,
    clerk:{verifier:crypt.verifier,liveness:async id=>provider?provider(id):({...id,status:live?"active":"revoked",accountEnabled:true,expiresAt:pool.now+86400000}),staff:{validate,newAssignmentId:()=>crypto.randomUUID()}}});
  let handler=createConfiguredHttpHandler(config());
  const call=async(method,path,body,token,key="domain-command")=>{
    const response=await handler(new Request("https://api.example.com/api/v1"+path,{method,headers:{...(token?{authorization:"Bearer "+token}:{}),...(body!==undefined?{"content-type":"application/json"}:{}),"idempotency-key":key},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
    return{status:response.status,json:await response.json()};
  };
  const sign=options=>crypt.sign(options),login=async(options)=>call("POST","/auth/clerk",{},await sign(options));
  const restart=()=>{const now=pool.now;pool=domainExecutor(f.path);pool.now=now;handler=createConfiguredHttpHandler(config());};
  const update=fn=>{const d=pool.read();fn(d);durableWrite(f.path,d);};
  return{...f,call,sign,login,restart,update,config,read:()=>pool.read(),get store(){return pool;},setLive:value=>{live=value;},setProvider:fn=>{provider=fn;}};
}
async function prepare(f){
  const session=await f.login({userId:users.other,sessionId:"sess_NewDomainFlowA1"});assert.equal(session.status,200,JSON.stringify(session));const token=session.json.data.access_token;
  assert.equal(f.read().people[session.json.data.profile.person_id].telegram_id,null);
  assert.equal((await f.call("PATCH","/me",{first_name:"Fresh",last_name:"Physics"},token)).status,200);
  const teacher=await f.sign({userId:users.teacher,sessionId:sids.teacher}),admin=await f.sign({userId:users.admin,sessionId:sids.admin});
  for(const q of f.plan.questions){const r=await f.call("PUT",`${f.versionPath}/questions/${q.id}`,q,teacher,`domain-question:${q.id}`);assert.equal(r.status,200,JSON.stringify(r));}
  assert.equal((await f.call("PATCH",f.versionPath,f.plan.metadata,teacher,"domain-duration")).status,200);
  const published=await f.call("POST",f.versionPath+"/publish",f.plan.publish,teacher,"domain-publish");assert.equal(published.status,200,JSON.stringify(published));
  assert.equal((await f.call("PUT",`/admin/groups/${f.group}/members`,{...f.memberBody,student_id:session.json.data.profile.person_id},admin,"domain-member")).status,200);
  const assignmentBody={...f.assignmentBody(published.json.data),student_ids:[session.json.data.profile.person_id]};
  const assignment=await f.call("POST","/admin/assignments",assignmentBody,admin,"domain-assignment");assert.equal(assignment.status,201,JSON.stringify(assignment));
  const started=await f.call("POST",`/exams/${assignment.json.data.id}/attempts`,{confirmed:true},token,"domain-start");assert.equal(started.status,200,JSON.stringify(started));
  return{token,session:session.json.data,assignment:assignment.json.data,assignmentBody,attempt:started.json.data};
}

test("new Clerk identity traverses configured HTTP to nullable Telegram/profile/exams without a seed or RAM store",async t=>{
  const f=await fixture(t),created=await f.login({userId:users.other,sessionId:"sess_NewDomainA1"});assert.equal(created.status,200,JSON.stringify(created));
  const session=created.json.data,id=session.profile.person_id;assert.equal(f.read().people[id].telegram_id,null);assert.equal(f.read().memberships[id].active,false);
  assert.equal((await f.call("PATCH","/me",{first_name:"New",last_name:"Student"},session.access_token)).status,200);
  f.restart();assert.equal((await f.call("GET","/me",undefined,session.access_token)).json.data.first_name,"New");
  assert.deepEqual((await f.call("GET","/exams",undefined,session.access_token)).json.data,[]);
  assert.equal(Object.values(f.read().clerkBindings).filter(b=>b.personId===id).length,1);
});

test("Teacher publish -> Admin membership/explicit assignment -> save/clear -> new login/restart -> result/history share durable row ports",async t=>{
  const f=await fixture(t),p=await prepare(f),q=p.attempt.questions[0],option=q.options.find(o=>o.blocks[0].markdown==="Yangi A").id;
  const save=(rev,value,token=p.token)=>f.call("PUT",`/attempts/${p.attempt.id}/answers/${q.id}`,{selected_option_id:value,expected_revision:rev},token);
  assert.equal((await save(0,option)).json.data.revision,1);assert.equal((await save(1,null)).json.data.revision,2);assert.equal((await save(1,option)).status,409);assert.equal((await save(2,option)).json.data.revision,3);
  const before=f.read(),second=await f.login({userId:users.other,sessionId:sids.second});assert.equal(second.status,200,JSON.stringify(second));const token=second.json.data.access_token;
  assert.deepEqual(f.read().attempts,before.attempts);assert.deepEqual(f.read().answers,before.answers);assert.deepEqual(f.read().series,before.series);
  assert.equal((await f.call("GET","/me",undefined,p.token)).status,401);
  assert.equal((await f.call("POST","/auth/refresh",{refresh_token:p.session.refresh_token})).status,401);
  f.restart();const resumed=await f.call("GET",`/attempts/${p.attempt.id}`,undefined,token);assert.equal(resumed.status,200,JSON.stringify(resumed));assert.equal(resumed.json.data.deadline_at,p.attempt.deadline_at);assert.equal(resumed.json.data.answers[0].revision,3);
  const submitted=await f.call("POST",`/attempts/${p.attempt.id}/submit`,undefined,token,"domain-submit");assert.equal(submitted.status,200,JSON.stringify(submitted));
  assert.deepEqual(submitted.json.data.ordinary.display,{earned_points:"0.1",max_points:"0.3",percentage:"50.00"});
  assert.deepEqual((await f.call("GET",`/attempts/${p.attempt.id}/result`,undefined,token)).json.data,submitted.json.data);
  assert.deepEqual((await f.call("GET",`/exams/${p.assignment.id}/history`,undefined,token)).json.data.attempts[0].score,submitted.json.data);
  assert.deepEqual(f.read().bonuses,before.bonuses);assert.equal(Object.values(f.read().families).filter(f=>f.person_id===p.session.profile.person_id&&f.revoked_at_ms===null).length,1);
});

test("F1 binding/provenance/fence loss is denied by me and refresh, without guessed repair",async t=>{
  for(const kind of ["binding","origin","fence"]){
    const f=await fixture(t),r=await f.login();assert.equal(r.status,200);const session=r.json.data,id=Object.keys(f.read().clerkBindings)[0];
    f.update(d=>{if(kind==="binding")delete d.clerkBindings[id];if(kind==="origin")delete d.families[id].auth_provider;if(kind==="fence")d.clerkFences={};});const before=f.raw();
    assert.equal((await f.call("GET","/me",undefined,session.access_token)).status,503);
    assert.equal((await f.call("POST","/auth/refresh",{refresh_token:session.refresh_token})).status,503);assert.equal(f.raw(),before);
  }
});

test("Clerk jti replay and provider denial survive handler restart; failed login leaves old family/domain intact",async t=>{
  const f=await fixture(t),proof=await f.sign(),first=await f.call("POST","/auth/clerk",{},proof);assert.equal(first.status,200);const before=f.raw();f.restart();
  assert.equal((await f.call("POST","/auth/clerk",{},proof)).status,409);assert.equal(f.raw(),before);
  f.setLive(false);assert.equal((await f.login({sessionId:sids.second})).status,401);assert.equal(f.raw(),before);
  f.setLive(true);assert.equal((await f.call("GET","/me",undefined,first.json.data.access_token)).status,200);
});

test("commit uncertainty returns503 without proof ACK; committed jti cannot be reused",async t=>{
  const f=await fixture(t),token=await f.sign();f.store.failCommit="after";const result=await f.call("POST","/auth/clerk",{},token);
  assert.equal(result.status,503);assert.equal(result.json.data,undefined);f.restart();assert.equal((await f.call("POST","/auth/clerk",{},token)).status,409);
});

test("shorter second provider expiry reached during auth writes rolls back before proof ACK",async t=>{
  const f=await fixture(t),at=f.store.now,before=f.raw();let reads=0;
  f.setProvider(id=>({...id,status:"active",accountEnabled:true,expiresAt:at+(++reads===1?2000:1000)}));
  f.store.clerkHook=name=>{if(name==="ua_clerk_refresh_write")f.store.now=at+1000;};
  const denied=await f.login({userId:users.other,sessionId:"sess_ExpiryDomainB2"});assert.equal(denied.status,401,JSON.stringify(denied));assert.equal(denied.json.data,undefined);assert.equal(f.raw(),before);
});

test("expiry409 commits result maintenance through the auth/domain transaction, without losing F1",async t=>{
  const f=await fixture(t),p=await prepare(f),bindings=structuredClone(f.read().clerkBindings);f.store.now=Date.parse(p.attempt.deadline_at)-1;
  const renewed=await f.call("POST","/auth/refresh",{refresh_token:p.session.refresh_token});assert.equal(renewed.status,200,JSON.stringify(renewed));const token=renewed.json.data.access_token;f.store.now++;
  const expired=await f.call("PUT",`/attempts/${p.attempt.id}/answers/${p.attempt.questions[0].id}`,{selected_option_id:null,expected_revision:0},token);
  assert.equal(expired.status,409,JSON.stringify(expired));assert.equal(f.read().attempts[p.attempt.id].body.status,"expired");f.restart();
  assert.equal((await f.call("GET",`/attempts/${p.attempt.id}/result`,undefined,token)).status,200);assert.deepEqual(f.read().clerkBindings,bindings);
});

test("legacy direct helper rejects Clerk provenance; Telegram relogin stamps origin and retires old Clerk SID",async t=>{
  const f=await fixture(t),r=await f.login(),session=r.json.data,id=session.profile.person_id,digest=await proofHash(session.access_token);
  await assert.rejects(new PostgresTransactions(f.store).run([id],tx=>new SessionRows().authorize(tx,id,digest)),e=>e.status===503);
  const telegramId=f.read().people[id].telegram_id;
  const tg=await f.call("POST","/auth/telegram",{init_data:signedInitData(telegramId,crypto.randomUUID(),f.store.now)});assert.equal(tg.status,200,JSON.stringify(tg));
  assert.equal((await f.login()).status,401);assert.equal((await f.call("GET","/me",undefined,tg.json.data.access_token)).status,200);
  assert.ok(Object.values(f.read().families).some(v=>v.person_id===id&&v.revoked_at_ms===null&&v.auth_provider==="telegram"));
});

test("Clerk Admin manage_content alone assigns, roster is separate, and revoked rights block receipt replay",async t=>{
  const f=await fixture(t),p=await prepare(f),admin=await f.sign({userId:users.admin,sessionId:sids.admin});
  f.update(d=>{d.staffAccess[f.actors.admin.person].manage_roster=false;});
  assert.equal((await f.call("PUT",`/admin/groups/${f.group}/members`,f.memberBody,admin,"domain-member")).status,403);
  assert.equal((await f.call("POST","/admin/assignments",p.assignmentBody,admin,"domain-assignment")).status,201);
  f.update(d=>{d.staffAccess[f.actors.admin.person].manage_content=false;});
  assert.equal((await f.call("POST","/admin/assignments",p.assignmentBody,admin,"domain-assignment")).status,403);
  assert.equal(f.read().memberships[p.session.profile.person_id].active,true);
});

test("already-calculated nullable statistical bonus remains exact and separate across login/reload/history",async t=>{
  const f=await fixture(t),p=await prepare(f);assert.equal((await f.call("POST",`/attempts/${p.attempt.id}/submit`,undefined,p.token,"bonus-submit")).status,200);
  // Represents an existing authorized upstream calculation, not bonus activation.
  f.update(d=>{d.bonuses[p.attempt.id]={personId:p.session.profile.person_id,calculationId:crypto.randomUUID(),earned:{numerator:"1",denominator:"8"},calculatedAt:f.store.now};});
  const before=f.read(),resultBefore=await f.call("GET",`/attempts/${p.attempt.id}/result`,undefined,p.token);assert.equal(resultBefore.json.data.statistical_bonus.earned_points,0.125);
  const login=await f.login({userId:users.other,sessionId:sids.second});assert.equal(login.status,200);f.restart();
  assert.deepEqual(f.read().bonuses,before.bonuses);assert.deepEqual(f.read().results,before.results);
  const result=await f.call("GET",`/attempts/${p.attempt.id}/result`,undefined,login.json.data.access_token);assert.deepEqual(result.json.data,resultBefore.json.data);
  const history=await f.call("GET",`/exams/${p.assignment.id}/history`,undefined,login.json.data.access_token);assert.deepEqual(history.json.data.attempts[0].score,resultBefore.json.data);
});
