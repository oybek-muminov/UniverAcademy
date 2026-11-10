import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import {startConfiguredServer} from "../../runtime/configured-server.mjs";
import {PostgresTransactions} from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";
import {StudentIdentityRows} from "../../supabase/functions/univeracademy-api/storage/student-identity-rows.ts";
import {StaffAccessRows} from "../../supabase/functions/univeracademy-api/storage/staff-access-rows.ts";
import {canWriteContent,groupScope,requireRosterAuthority} from "../../supabase/functions/univeracademy-api/staff-state.ts";
import {createProductionStudentClient,STUDENT_CONTRACT_SHA256,StudentApiError} from "../../packages/api-client/student-client.ts";
import {httpExecutor} from "../persistent-http/executor.mjs";
import {durableWrite} from "../storage-auth/disk-executor.mjs";
import {botKey,signedInitData,clock,testNumbers,testPolicy} from "../backend/http-fixture.ts";
import {validate} from "../backend/staff-fixture.ts";

function empty(){return{people:{},memberships:{},assignments:{},grants:{},families:{},access:{},refresh:{},replays:{},series:{},attempts:{},answers:{},results:{},receipts:{},bonuses:{},cancellations:{},staffIdentities:{},staffAccess:{},staffGroups:{},staffSubjects:{},teacherSubjects:{},providerSessions:{}};}
async function setup(t){
  const dir=mkdtempSync(join(tmpdir(),"ua-unseeded-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"rows.json");durableWrite(path,empty());
  let pool=httpExecutor(path);pool.now=clock;let staff;
  const config=()=>({mode:"local_contract",storage:{kind:"postgres_contract_double",pool},botToken:botKey,sessionPolicy:testPolicy,numericPresentation:testNumbers,now:()=>pool.now,...(staff?{staff}:{})});
  let local=await startConfiguredServer({config:config()});t.after(()=>local.close());
  // Explicit test transport maps a configured HTTPS production-client request to
  // loopback. No DNS/TLS/provider request is made to the configured production host.
  const client=createProductionStudentClient({mode:"production",contractSha256:STUDENT_CONTRACT_SHA256,baseUrl:"https://api.univeracademy.uz/api/v1",transport:async request=>{
    const url=new URL(request.url),raw=await request.text();return fetch(local.baseUrl+url.pathname.slice("/api/v1".length),{method:request.method,headers:request.headers,
      ...(raw?{body:raw}:{}),redirect:request.redirect,credentials:request.credentials,cache:request.cache});
  }});
  const launch=(telegram=4000000101)=>signedInitData(telegram,crypto.randomUUID(),pool.now);
  const login=async(telegram=4000000101)=>(await client.telegramLogin({init_data:launch(telegram)})).data;
  return {path,client,launch,login,get pool(){return pool;},get local(){return local;},config,
    async restart(nextStaff=staff){await local.close();staff=nextStaff;const now=pool.now;pool=httpExecutor(path);pool.now=now;local=await startConfiguredServer({config:config()});}};
}
test("empty storage creates an unprivileged student through HTTP; production constructor reads profile/empty exams after restart",async(t)=>{
  const f=await setup(t);assert.equal(Object.keys(f.pool.read().people).length,0);
  const session=await f.login(),p=session.profile;assert.match(p.person_id,/^[0-9a-f-]{36}$/);assert.match(p.qadam_id,/^\d{10}$/);
  assert.deepEqual(p.roles,["student"]);assert.equal(p.registration_complete,false);assert.equal(p.active_group_id,null);
  const disk=f.pool.read();assert.equal(Object.keys(disk.people).length,1);assert.equal(disk.memberships[p.person_id].active,false);assert.deepEqual(disk.grants,{});assert.deepEqual(disk.staffIdentities,{});
  assert.ok(f.pool.events.indexOf("ua_telegram_identity_lock")<f.pool.events.indexOf("ua_identity_insert"));
  assert.ok(f.pool.events.indexOf("ua_identity_insert")<f.pool.events.indexOf("ua_people_lock"));
  await f.client.updateProfile(session.access_token,{first_name:"Yangi",last_name:"O‘quvchi"});assert.deepEqual((await f.client.exams(session.access_token)).data,[]);
  await assert.rejects(f.client.updateProfile(session.access_token,{first_name:"X",last_name:"Y",roles:["owner"]}),e=>e instanceof StudentApiError&&e.status===422);
  await f.restart();const restored=(await f.client.me(session.access_token)).data;assert.equal(restored.person_id,p.person_id);assert.equal(restored.first_name,"Yangi");
  const raw=readFileSync(f.path,"utf8");assert.ok(!raw.includes(session.access_token));assert.ok(!raw.includes(session.refresh_token));
});
test("invalid/expired queued login and a write failure leave no person, membership, replay or family behind",async(t)=>{
  const f=await setup(t),before=readFileSync(f.path,"utf8");
  await assert.rejects(f.client.telegramLogin({init_data:f.launch().replace(/hash=[^&]+/,"hash=bad")}),e=>e.status===401);assert.equal(readFileSync(f.path,"utf8"),before);
  f.pool.beforeLock=async()=>{f.pool.now+=121000;};await assert.rejects(f.client.telegramLogin({init_data:f.launch()}),e=>e.code==="INIT_DATA_EXPIRED");assert.equal(readFileSync(f.path,"utf8"),before);
  f.pool.failStatement="ua_http_family_merge";await assert.rejects(f.login(),e=>e.status===500);assert.equal(readFileSync(f.path,"utf8"),before);
  assert.equal((await f.login()).profile.roles[0],"student");
});
test("concurrent first logins create one canonical person; same initData is consumed once and only one fresh family stays active",async(t)=>{
  const f=await setup(t),raw=f.launch();const same=await Promise.allSettled([f.client.telegramLogin({init_data:raw}),f.client.telegramLogin({init_data:raw})]);
  assert.equal(same.filter(x=>x.status==="fulfilled").length,1);assert.equal(same.find(x=>x.status==="rejected").reason.code,"INIT_DATA_REPLAY");
  assert.equal(Object.keys(f.pool.read().people).length,1);
  const [a,b]=await Promise.all([f.login(),f.login()]);assert.equal(a.profile.person_id,b.profile.person_id);
  const checks=await Promise.allSettled([f.client.me(a.access_token),f.client.me(b.access_token)]);assert.equal(checks.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(Object.values(f.pool.read().families).filter(x=>x.revoked_at_ms===null).length,1);assert.equal(Object.keys(f.pool.read().people).length,1);
});
test("unknown first-login COMMIT is never ACKed or auto-retried; fresh launch recovers the canonical identity",async(t)=>{
  for(const failure of ["before","after"]){const f=await setup(t);f.pool.failCommit=failure;
    await assert.rejects(f.login(),e=>e.status===503&&e.code==="SERVICE_UNAVAILABLE");const ids=Object.keys(f.pool.read().people);assert.equal(ids.length,failure==="after"?1:0);
    const recovered=await f.login();if(ids.length)assert.equal(recovered.profile.person_id,ids[0]);assert.equal(Object.keys(f.pool.read().people).length,1);
    assert.equal(Object.values(f.pool.read().families).filter(x=>x.revoked_at_ms===null).length,1);
  }
});
test("Qadam uniqueness retries collision without a seeded user or overwrite and exhausts only the configured bound",async(t)=>{
  const f=await setup(t),first=await f.login();const qadam=first.profile.qadam_id,other=qadam==="1111111111"?"2222222222":"1111111111";
  const candidates=[qadam,other],rows=new StudentIdentityRows({qadamId:()=>candidates.shift()});const runner=new PostgresTransactions(f.pool);
  const raw=f.launch(4000000102);const person=await runner.runIdentity(4000000102,gate=>rows.ensure(gate,raw,{botToken:botKey,sessionPolicy:testPolicy}),async tx=>tx.personIds[0]);
  assert.notEqual(person,first.profile.person_id);assert.equal(f.pool.read().people[person].profile.qadam_id,other);assert.equal(Object.keys(f.pool.read().people).length,2);
  const before=readFileSync(f.path,"utf8"),exhaust=new StudentIdentityRows({qadamId:()=>qadam});
  await assert.rejects(runner.runIdentity(4000000103,gate=>exhaust.ensure(gate,f.launch(4000000103),{botToken:botKey,sessionPolicy:testPolicy}),async()=>assert.fail("must not execute")),e=>e.status===503);
  assert.equal(readFileSync(f.path,"utf8"),before);
});
test("existing disabled or non-student identity is not recreated, enabled or silently granted the student role",async(t)=>{
  for(const change of [p=>{p.enabled=false;},p=>{p.roles=["admin"];p.profile.roles=["admin"];}]){
    const f=await setup(t),session=await f.login(),disk=f.pool.read();change(disk.people[session.profile.person_id]);durableWrite(f.path,disk);
    const before=readFileSync(f.path,"utf8");await assert.rejects(f.login(),e=>e.status===403);assert.equal(readFileSync(f.path,"utf8"),before);assert.equal(Object.keys(f.pool.read().people).length,1);
  }
});

const noStudent=()=>({people:{},families:{},access:{},refresh:{},consumedInitData:{},grants:{},assignments:{},series:{},attempts:{},receipts:{},bonuses:{},cancellations:{}});
async function staffSetup(f){
  const user=await f.login(),person=user.profile.person_id,subject=crypto.randomUUID(),session=crypto.randomUUID(),group=crypto.randomUUID(),draft=crypto.randomUUID(),issuer="https://synthetic.invalid/auth/v1";
  const pair=await generateKeyPair("ES256"),publicKey=await exportJWK(pair.publicKey);publicKey.kid="unseeded-staff";
  const disk=f.pool.read();disk.staffIdentities[issuer+"|"+subject]={person_id:person,revoked_at_ms:null};
  disk.staffAccess[person]={approved:true,manage_content:false,manage_roster:false,all_groups:false,all_subjects:false};
  disk.staffGroups[person]=[{group_id:group,revoked_at_ms:null}];disk.staffSubjects[person]=[{subject_id:"physics",revoked_at_ms:null}];disk.teacherSubjects[person]=[];
  disk.providerSessions[session]=subject;
  disk.staffProjection={staff:{[subject]:{personId:person,roles:["owner"],enabled:true,approved:true,capabilities:{manage_content:true,manage_roster:true},scope:{all_groups:true,all_subjects:true,group_ids:[],subject_ids:[]},approvedSubjectIds:["physics"]}},
    versions:{[draft]:{subjectId:"physics",questionIds:[],wire:{id:draft,demo_id:crypto.randomUUID(),version_no:1,duration_seconds:60,instructions_blocks:[{type:"text",markdown:"synthetic"}],grading_config:{individual_enabled:false},status:"draft",revision:0}}},
    groups:{},memberships:{},recoveryAssignments:{},notifications:{},approvals:{},receipts:{},audit:[]};durableWrite(f.path,disk);
  const ports={jwt:{issuer,audience:"authenticated",algorithms:["ES256"],trustedKeys:createLocalJWKSet({keys:[publicKey]}),now:()=>f.pool.now},
    load:async tx=>({...((await tx.client.query({name:"ua_contract_staff_load",text:"SELECT synthetic domain projection",values:[]})).rows[0]),student:noStudent()}),
    flush:async(tx,before,after)=>{const{student,...projection}=after;await tx.client.query({name:"ua_contract_staff_write",text:"UPDATE synthetic domain projection",values:[JSON.stringify(projection)]});},
    liveness:async({transaction,sessionId,subject})=>(await transaction.client.query({name:"ua_contract_staff_session",text:"SELECT synthetic provider session",values:[sessionId,subject]})).rowCount===1,
    validate,newAssignmentId:()=>crypto.randomUUID()};
  const secs=Math.floor(f.pool.now/1000),token=await new SignJWT({iss:issuer,aud:"authenticated",sub:subject,session_id:session,iat:secs-1,exp:secs+900,role:"authenticated",user_metadata:{roles:["owner"]}}).setProtectedHeader({alg:"ES256",kid:publicKey.kid}).sign(pair.privateKey);
  await f.restart(ports);
  const proof={kind:"staff_verified",subject,issuer,providerSessionId:session,notBefore:(secs-1)*1000,expiresAt:(secs+900)*1000};
  const patch=async()=>{const r=await fetch(f.local.baseUrl+`/admin/versions/${draft}`,{method:"PATCH",headers:{authorization:"Bearer "+token,"content-type":"application/json","idempotency-key":"current-db-permission"},body:JSON.stringify({expected_revision:0,duration_seconds:420,instructions_blocks:[{type:"text",markdown:"new current permissions"}],grading_config:{individual_enabled:false}})});return{status:r.status,json:await r.json()};};
  const update=fn=>{const d=f.pool.read();fn(d);durableWrite(f.path,d);};
  const roles=values=>update(d=>{d.people[person].roles=values;d.people[person].profile.roles=values;});
  return{person,subject,session,issuer,group,draft,proof,patch,update,roles};
}
test("staff authority comes from current normalized rows, never JWT metadata or a cached owner projection",async(t)=>{
  const f=await setup(t),s=await staffSetup(f);assert.equal((await s.patch()).status,403); // real current role is student only
  s.roles(["student","admin"]);assert.equal((await s.patch()).status,404); // no content capability
  s.update(d=>{d.staffAccess[s.person].manage_content=true;d.staffSubjects[s.person][0].revoked_at_ms=clock;});assert.equal((await s.patch()).status,404);
  s.update(d=>{d.staffSubjects[s.person][0].revoked_at_ms=null;});const first=await s.patch();assert.equal(first.status,200,JSON.stringify(first.json));
  assert.deepEqual(await s.patch(),first);s.update(d=>{d.staffAccess[s.person].manage_content=false;});assert.equal((await s.patch()).status,404);
  assert.equal(f.pool.read().staffProjection.audit.length,1);
});
test("group/subject/all-scope and Teacher approval readers reflect current revocation; roster stays independent",async(t)=>{
  const f=await setup(t),s=await staffSetup(f),rows=new StaffAccessRows(),runner=new PostgresTransactions(f.pool);
  s.roles(["student","admin"]);s.update(d=>{d.staffAccess[s.person].manage_content=true;});
  const read=()=>runner.run([s.person],tx=>rows.load(tx,s.proof,s.person));let record=await read();assert.equal(groupScope(record,s.group),true);assert.equal(canWriteContent(record,"physics"),true);
  assert.throws(()=>requireRosterAuthority(record),e=>e.code==="CAPABILITY_REQUIRED");
  s.update(d=>{d.staffGroups[s.person][0].revoked_at_ms=clock;d.staffSubjects[s.person][0].revoked_at_ms=clock;});record=await read();assert.equal(groupScope(record,s.group),false);assert.equal(canWriteContent(record,"physics"),false);
  s.update(d=>{d.staffAccess[s.person].all_groups=true;d.staffAccess[s.person].all_subjects=true;});record=await read();assert.equal(groupScope(record,crypto.randomUUID()),true);assert.equal(canWriteContent(record,"math"),true);
  s.roles(["student","teacher"]);s.update(d=>{d.staffAccess[s.person].all_subjects=false;d.staffAccess[s.person].all_groups=false;d.staffAccess[s.person].manage_content=false;d.teacherSubjects[s.person]=[{subject_id:"physics",approved:true,revoked_at_ms:null}];});
  record=await read();assert.equal(canWriteContent(record,"physics"),true);assert.deepEqual(record.scope.group_ids,[]);
  s.update(d=>{d.teacherSubjects[s.person][0].approved=false;});assert.equal(canWriteContent(await read(),"physics"),false);
});
test("current mapping/access/approval/account/session revocation fails closed even with the same signed staff JWT",async(t)=>{
  const f=await setup(t),s=await staffSetup(f);s.roles(["student","admin"]);s.update(d=>{d.staffAccess[s.person].manage_content=true;});
  for(const[change,status]of[
    [d=>{d.staffIdentities[s.issuer+"|"+s.subject].revoked_at_ms=clock;},401],
    [d=>{delete d.staffAccess[s.person];},401],[d=>{d.staffAccess[s.person].approved=false;},403],
    [d=>{d.people[s.person].enabled=false;},403],[d=>{delete d.providerSessions[s.session];},401]]){
    const before=f.pool.read();s.update(change);assert.equal((await s.patch()).status,status);durableWrite(f.path,before);
  }
  assert.equal(f.pool.read().staffProjection.audit.length,0);
  assert.equal(f.pool.events.filter(n=>n==="ua_contract_staff_load").length,0); // reject before private domain loading
});
