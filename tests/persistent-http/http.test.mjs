import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {startConfiguredServer} from "../../runtime/configured-server.mjs";
import {createConfiguredHttpHandler} from "../../supabase/functions/univeracademy-api/configured-http.ts";
import {StudentHttpRows} from "../../supabase/functions/univeracademy-api/storage/student-http-rows.ts";
import {createContentPilotLab} from "../../runtime/content-pilot-lab.mjs";
import {startContentPilotServer} from "../../runtime/content-pilot-server.mjs";
import {publishContentPilot,assignContentPilot} from "../../runtime/content-pilot-driver.mjs";
import {clock,botKey,signedInitData,testNumbers,id} from "../backend/http-fixture.ts";
import {LOCAL_CANDIDATE_POLICY} from "../../runtime/local-lab.mjs";
import {seedStudent,httpExecutor} from "./executor.mjs";
import {durableWrite} from "../storage-auth/disk-executor.mjs";
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import {validate} from "../backend/staff-fixture.ts";

async function scenario(t){
  const dir=mkdtempSync(join(tmpdir(),"ua-http-rows-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"rows.json");
  // Explicit RAM staff fixture is setup only. It publishes version31 via HTTP;
  // the configured/persistent server never imports or falls back to this setup.
  const lab=createContentPilotLab({now:()=>clock});lab.store.state.student.people[lab.run.fixture.studentId].profile.registration_complete=true;
  const setup=await startContentPilotServer({lab});let published;
  try{published=await publishContentPilot(setup.run);await assignContentPilot(setup.run,published);}finally{await setup.close();}
  seedStudent(path,lab.store.state.student);let pool=httpExecutor(path);pool.now=clock;
  const makeConfig=()=>({mode:"local_contract",storage:{kind:"postgres_contract_double",pool},botToken:botKey,sessionPolicy:LOCAL_CANDIDATE_POLICY,numericPresentation:testNumbers,now:()=>pool.now});
  let server=await startConfiguredServer({config:makeConfig()});t.after(()=>server.close());
  async function call(method,url,body,token,key="persistent-http-command"){
    const response=await fetch(server.baseUrl+url,{method,headers:{...(token?{authorization:"Bearer "+token}:{}),"content-type":"application/json","idempotency-key":key},body:body===undefined?undefined:JSON.stringify(body)});
    const json=await response.json();assert.equal(response.headers.get("cache-control"),"no-store");return{status:response.status,json};
  }
  async function login(){const r=await call("POST","/auth/telegram",{init_data:signedInitData(4000000002,crypto.randomUUID(),pool.now)});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.data;}
  async function start(token){const r=await call("POST",`/exams/${lab.run.fixture.assignmentId}/attempts`,{confirmed:true},token,"persistent-start");assert.equal(r.status,200,JSON.stringify(r.json));return r.json.data;}
  return {path,fixture:lab.run.fixture,published,call,login,start,get pool(){return pool;},get server(){return server;},makeConfig,
    async restart(){await server.close();pool=httpExecutor(path);pool.now=clock;server=await startConfiguredServer({config:makeConfig()});}};
}

test("HTTP login/profile -> new published exam/start -> save/clear -> separate process resume -> submit/result/history persists exact state",async(t)=>{
  const f=await scenario(t),session=await f.login(),token=session.access_token;
  assert.equal((await f.call("PATCH","/me",{first_name:"Davom",last_name:"Sintetik"},token)).status,200);
  const exams=await f.call("GET","/exams",undefined,token);assert.equal(exams.status,200);assert.equal(exams.json.data[0].version_id,f.published.id);
  const attempt=await f.start(token);assert.equal(Date.parse(attempt.deadline_at)-Date.parse(attempt.started_at),420000);
  const question=attempt.questions[0],selected=question.options.find(o=>o.blocks[0].markdown==="Yangi A").id;
  const save=(revision,option)=>f.call("PUT",`/attempts/${attempt.id}/answers/${question.id}`,{selected_option_id:option,expected_revision:revision},token);
  assert.equal((await save(0,selected)).json.data.revision,1);
  assert.equal((await save(1,null)).json.data.revision,2);
  assert.equal((await save(1,selected)).status,409);
  assert.equal((await save(2,selected)).json.data.revision,3);
  await f.restart();const restored=await f.call("GET",`/attempts/${attempt.id}`,undefined,token);
  assert.equal(restored.status,200);assert.equal(restored.json.data.deadline_at,attempt.deadline_at);assert.equal(restored.json.data.answers[0].revision,3);
  const script=`import{startConfiguredServer}from ${JSON.stringify(pathToFileURL(join(process.cwd(),"runtime/configured-server.mjs")).href)};import{httpExecutor}from ${JSON.stringify(pathToFileURL(join(process.cwd(),"tests/persistent-http/executor.mjs")).href)};import{testNumbers,botKey,clock}from ${JSON.stringify(pathToFileURL(join(process.cwd(),"tests/backend/http-fixture.ts")).href)};import{LOCAL_CANDIDATE_POLICY}from ${JSON.stringify(pathToFileURL(join(process.cwd(),"runtime/local-lab.mjs")).href)};let input="";for await(const b of process.stdin)input+=b;const{path,token,attempt}=JSON.parse(input);const pool=httpExecutor(path);pool.now=clock;const s=await startConfiguredServer({config:{mode:"local_contract",storage:{kind:"postgres_contract_double",pool},botToken:botKey,sessionPolicy:LOCAL_CANDIDATE_POLICY,numericPresentation:testNumbers,now:()=>pool.now}});try{const r=await fetch(s.baseUrl+"/attempts/"+attempt,{headers:{authorization:"Bearer "+token}});console.log(JSON.stringify({status:r.status,body:await r.json()}));}finally{await s.close();}`;
  const child=JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",script],{input:JSON.stringify({path:f.path,token,attempt:attempt.id}),encoding:"utf8"}));
  assert.equal(child.status,200);assert.equal(child.body.data.answers[0].revision,3);assert.equal(child.body.data.deadline_at,attempt.deadline_at);
  const submitted=await f.call("POST",`/attempts/${attempt.id}/submit`,undefined,token,"persistent-submit");assert.equal(submitted.status,200,JSON.stringify(submitted.json));
  assert.deepEqual(submitted.json.data.ordinary.display,f.fixture.expectedDisplay);
  assert.deepEqual((await f.call("GET",`/attempts/${attempt.id}/result`,undefined,token)).json.data,submitted.json.data);
  assert.deepEqual((await f.call("GET",`/exams/${f.fixture.assignmentId}/history`,undefined,token)).json.data.attempts[0].score,submitted.json.data);
  assert.equal((await f.call("GET","/me",undefined,token)).json.data.first_name,"Davom");
  const disk=readFileSync(f.path,"utf8");assert.ok(!disk.includes(token));assert.ok(!disk.includes(session.refresh_token));
  assert.equal(JSON.parse(disk).attempts[attempt.id].frozen_test.versionId,f.published.id);
});

test("HTTP expiry at deadline commits ordinary+terminal state before409 and survives server restart",async(t)=>{
  const f=await scenario(t),session=await f.login(),attempt=await f.start(session.access_token);f.pool.now=Date.parse(attempt.deadline_at);
  const r=await f.call("PUT",`/attempts/${attempt.id}/answers/${attempt.questions[0].id}`,{selected_option_id:null,expected_revision:0},session.access_token);
  assert.equal(r.status,409);assert.equal(r.json.error.code,"ATTEMPT_EXPIRED");
  assert.equal(f.pool.read().attempts[attempt.id].body.status,"expired");await f.restart();
  const result=await f.call("GET",`/attempts/${attempt.id}/result`,undefined,session.access_token);assert.equal(result.status,200);assert.equal(result.json.data.ordinary.earned_points,0);
});

test("HTTP failed write and unknown COMMIT never ACK; reconciliation preserves committed revisions without reapplying command",async(t)=>{
  const f=await scenario(t),session=await f.login(),attempt=await f.start(session.access_token),q=attempt.questions[0];
  const save=()=>f.call("PUT",`/attempts/${attempt.id}/answers/${q.id}`,{selected_option_id:q.options[0].id,expected_revision:0},session.access_token);
  const before=readFileSync(f.path,"utf8");f.pool.failStatement="ua_answer_cas";assert.equal((await save()).status,500);assert.equal(readFileSync(f.path,"utf8"),before);
  f.pool.failCommit="after";assert.equal((await save()).status,503);assert.equal(f.pool.read().answers[attempt.id][q.id].revision,1);
  const resume=await f.call("GET",`/attempts/${attempt.id}`,undefined,session.access_token);assert.equal(resume.json.data.answers[0].revision,1);
  assert.equal((await save()).status,409);assert.equal(f.pool.read().answers[attempt.id][q.id].revision,1);
});

test("HTTP new login replaces the old family while answer, deadline and membership persist; bad login and old refresh cannot revoke it",async(t)=>{
  const f=await scenario(t),first=await f.login(),attempt=await f.start(first.access_token);
  assert.equal((await f.call("PUT",`/attempts/${attempt.id}/answers/${attempt.questions[0].id}`,{selected_option_id:null,expected_revision:0},first.access_token)).status,200);
  const bad=signedInitData(4000000002,crypto.randomUUID(),f.pool.now).replace(/hash=[^&]+/,"hash=bad");
  assert.equal((await f.call("POST","/auth/telegram",{init_data:bad})).status,401);
  assert.equal((await f.call("GET","/me",undefined,first.access_token)).status,200);
  const second=await f.login();assert.equal((await f.call("GET","/me",undefined,first.access_token)).status,401);
  const disk=readFileSync(f.path,"utf8");assert.equal((await f.call("POST","/auth/refresh",{refresh_token:first.refresh_token})).status,401);assert.equal(readFileSync(f.path,"utf8"),disk);
  const resumed=await f.call("GET",`/attempts/${attempt.id}`,undefined,second.access_token);assert.equal(resumed.status,200);assert.equal(resumed.json.data.deadline_at,attempt.deadline_at);assert.equal(resumed.json.data.answers[0].revision,1);
  assert.equal(Object.values(f.pool.read().families).filter(f=>f.revoked_at_ms===null).length,1);
});

test("production rejects missing storage/auth/policy and explicit contract-double kind; staff without ports remains unavailable",async(t)=>{
  for(const config of [undefined,{mode:"production"},{mode:"local_contract"}]){
    const server=await startConfiguredServer({config});try{const r=await fetch(server.baseUrl+"/exams");assert.equal(r.status,503);assert.equal((await r.json()).error.code,"SERVICE_UNAVAILABLE");}finally{await server.close();}
  }
  const f=await scenario(t),before=readFileSync(f.path,"utf8");
  for(const change of [c=>({...c,mode:"production"}),c=>({...c,botToken:""}),c=>({...c,numericPresentation:undefined}),c=>({...c,sessionPolicy:undefined})]){
    const r=await createConfiguredHttpHandler(change(f.makeConfig()))(new Request("http://local.invalid/api/v1/exams"));assert.equal(r.status,503);
  }
  assert.equal(readFileSync(f.path,"utf8"),before);
  assert.equal((await f.call("POST","/admin/assignments",{})).status,503);
});

test("invalid bearer never falls back to valid logout body; refresh reuse revokes only its own family across HTTP",async(t)=>{
  const f=await scenario(t),session=await f.login();const before=readFileSync(f.path,"utf8");
  assert.equal((await f.call("POST","/auth/logout",{refresh_token:session.refresh_token},"bad-bearer")).status,401);assert.equal(readFileSync(f.path,"utf8"),before);
  const refreshed=await f.call("POST","/auth/refresh",{refresh_token:session.refresh_token});assert.equal(refreshed.status,200);
  assert.equal((await f.call("POST","/auth/refresh",{refresh_token:session.refresh_token})).json.error.code,"REFRESH_REUSED");
  assert.equal((await f.call("GET","/me",undefined,refreshed.json.data.access_token)).status,401);
  const next=await f.login();assert.equal((await f.call("GET","/me",undefined,next.access_token)).status,200);
});

async function staffPorts(f){
  const subject=id(700),person=id(501),session=id(701),draft=id(32),issuer="https://synthetic.invalid/auth/v1";
  const keys=await generateKeyPair("ES256"),publicKey=await exportJWK(keys.publicKey);publicKey.kid="offline-http-key";
  const disk=f.pool.read();disk.people[person]={telegram_id:5000000001,enabled:true,roles:["admin"],profile:{person_id:person,roles:["admin"]}};
  disk.staffIdentities={[issuer+"|"+subject]:{person_id:person,revoked_at_ms:null}};
  disk.staffAccess={[person]:{approved:true,manage_content:true,manage_roster:false,all_groups:false,all_subjects:false}};
  disk.staffGroups={[person]:[{group_id:f.fixture.groupId,revoked_at_ms:null}]};disk.staffSubjects={[person]:[{subject_id:"physics",revoked_at_ms:null}]};disk.teacherSubjects={};
  disk.providerSessions={[session]:subject};disk.staffProjection={staff:{[subject]:{personId:person,enabled:true,approved:true,roles:["admin"],approvedSubjectIds:[],capabilities:{manage_content:true,manage_roster:false},scope:{all_groups:false,group_ids:[f.fixture.groupId],all_subjects:false,subject_ids:["physics"]}}},
    versions:{[draft]:{subjectId:"physics",questionIds:[],wire:{id:draft,demo_id:f.fixture.demoId,version_no:3,duration_seconds:60,instructions_blocks:[{type:"text",markdown:"synthetic"}],grading_config:{individual_enabled:false},status:"draft",revision:0}}},
    groups:{},memberships:{},recoveryAssignments:{},notifications:{},approvals:{},receipts:{},audit:[]};durableWrite(f.path,disk);
  const p={jwt:{issuer,audience:"authenticated",algorithms:["ES256"],trustedKeys:createLocalJWKSet({keys:[publicKey]}),now:()=>f.pool.now},
    resolvePersons:async()=>[person,f.fixture.studentId],
    load:async(tx)=>{const r=await tx.client.query({name:"ua_contract_staff_load",text:"SELECT synthetic staff projection",values:[]});return{...r.rows[0],student:await new StudentHttpRows().load(tx,f.fixture.studentId)};},
    flush:async(tx,before,after)=>{const {student,...projection}=after;await tx.client.query({name:"ua_contract_staff_write",text:"UPDATE synthetic staff projection",values:[JSON.stringify(projection)]});},
    liveness:async({transaction,sessionId,subject})=>(await transaction.client.query({name:"ua_contract_staff_session",text:"SELECT synthetic provider session",values:[sessionId,subject]})).rowCount===1,
    validate,newAssignmentId:()=>id(999)};
  const now=Math.floor(f.pool.now/1000),expires=(now+900)*1000;
  const token=await new SignJWT({iss:issuer,aud:"authenticated",sub:subject,session_id:session,iat:now-1,exp:now+900,role:"authenticated",user_metadata:{roles:["owner"]}}).setProtectedHeader({alg:"ES256",kid:publicKey.kid}).sign(keys.privateKey);
  async function patch(ports=p,proof=token){
    const server=await startConfiguredServer({config:{...f.makeConfig(),staff:ports}});
    try{const r=await fetch(server.baseUrl+`/admin/versions/${draft}`,{method:"PATCH",headers:{authorization:"Bearer "+proof,"idempotency-key":"staff-persistent-patch","content-type":"application/json"},body:JSON.stringify({expected_revision:0,duration_seconds:420,instructions_blocks:[{type:"text",markdown:"configured staff HTTP"}],grading_config:{individual_enabled:false}})});return{status:r.status,json:await r.json()};}finally{await server.close();}
  }
  return{patch,p,subject,person,session,draft,expires};
}
test("configured staff HTTP verifies real offline JWT, current scoped capability and required live session under the storage lock",async(t)=>{
  const f=await scenario(t),s=await staffPorts(f);
  const first=await s.patch();assert.equal(first.status,200,JSON.stringify(first.json));assert.equal(first.json.data.duration_seconds,420);
  assert.deepEqual(await s.patch(),first);assert.equal(f.pool.read().staffProjection.audit.length,1);
  assert.equal((await s.patch(s.p,"synthetic-admin-proof")).status,401);
  const disk=f.pool.read();disk.staffProjection.staff[s.subject].capabilities.manage_content=true;
  disk.staffAccess[s.person].manage_content=false;durableWrite(f.path,disk);
  assert.equal((await s.patch()).status,404); // forged JWT user_metadata owner did not grant authority
});
test("staff liveness/configuration/revocation and post-lock expiry fail closed; transport malformation remains400",async(t)=>{
  const f=await scenario(t),s=await staffPorts(f);
  assert.equal((await s.patch({...s.p,liveness:undefined})).status,503);
  let disk=f.pool.read();delete disk.providerSessions[s.session];durableWrite(f.path,disk);assert.equal((await s.patch()).status,401);
  disk=f.pool.read();disk.providerSessions[s.session]=s.subject;durableWrite(f.path,disk);
  f.pool.beforeLock=async()=>{f.pool.now=s.expires;};assert.equal((await s.patch()).status,401);
  assert.equal(f.pool.read().staffProjection.audit.length,0);
  const r=await fetch(f.server.baseUrl+"/auth/telegram",{method:"POST",body:"x".repeat(65537)});assert.equal(r.status,400);assert.equal((await r.json()).error.code,"MALFORMED_REQUEST");
});
test("HTTP access uses current membership epoch and keeps foreign attempts hidden without changing immutable data",async(t)=>{
  const f=await scenario(t),session=await f.login(),disk=f.pool.read();disk.memberships[f.fixture.studentId].epoch++;
  durableWrite(f.path,disk);const before=readFileSync(f.path,"utf8");
  const exams=await f.call("GET","/exams",undefined,session.access_token);assert.equal(exams.status,200);assert.deepEqual(exams.json.data,[]);
  const denied=await f.call("POST",`/exams/${f.fixture.assignmentId}/attempts`,{confirmed:true},session.access_token,"epoch-denied-start");assert.ok([403,404].includes(denied.status));
  assert.equal((await f.call("GET",`/attempts/${id(999)}`,undefined,session.access_token)).status,404);
  assert.equal(readFileSync(f.path,"utf8"),before);assert.equal(Object.keys(f.pool.read().attempts).length,0);
});
