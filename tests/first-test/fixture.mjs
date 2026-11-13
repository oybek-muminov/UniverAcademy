import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import {startConfiguredServer} from "../../runtime/configured-server.mjs";
import {createProductionStudentClient,STUDENT_CONTRACT_SHA256} from "../../packages/api-client/student-client.ts";
import {botKey,signedInitData,clock,testNumbers,testPolicy,ids} from "../backend/http-fixture.ts";
import {validate,staffIds} from "../backend/staff-fixture.ts";
import {contentPilotPlan} from "../../runtime/content-pilot-lab.mjs";
import {durableWrite} from "../storage-auth/disk-executor.mjs";
import {firstTestExecutor} from "./executor.mjs";

export const uiOrigin="http://127.0.0.1:5198";
export async function firstTestFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"ua-relational-first-")),path=join(dir,"synthetic-rows.json");
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  durableWrite(path,{people:{},memberships:{},assignments:{},grants:{},families:{},access:{},refresh:{},replays:{},series:{},attempts:{},answers:{},results:{},receipts:{},bonuses:{},cancellations:{},staffIdentities:{},staffAccess:{},staffGroups:{},staffSubjects:{},teacherSubjects:{},providerSessions:{},groups:{},versions:{},demos:{},questions:{},staffReceipts:{},staffAudit:[]});
  let pool=firstTestExecutor(path);pool.now=clock;let ports;
  const config=()=>({mode:"local_contract",storage:{kind:"postgres_contract_double",pool},botToken:botKey,sessionPolicy:testPolicy,numericPresentation:testNumbers,now:()=>pool.now,...(ports?{staff:ports}:{})});
  let local=await startConfiguredServer({config:config(),allowedOrigins:[uiOrigin]});t.after(()=>local.close());
  const client=createProductionStudentClient({mode:"production",baseUrl:"https://synthetic-api.invalid.example/api/v1",contractSha256:STUDENT_CONTRACT_SHA256,transport:async req=>{
    const raw=await req.text(),headers=new Headers(req.headers);headers.set("origin",uiOrigin);
    const response=await fetch(local.baseUrl+new URL(req.url).pathname.slice(7),{method:req.method,headers,...(raw?{body:raw}:{}),credentials:"omit",redirect:"error"});
    assert.equal(response.headers.get("access-control-allow-origin"),uiOrigin);return response;
  }});
  const login=async n=>(await client.telegramLogin({init_data:signedInitData(n,crypto.randomUUID(),pool.now)})).data;
  const student=await login(4000000201),admin=await login(4000000202),teacher=await login(4000000203);
  await client.updateProfile(student.access_token,{first_name:"Sintetik",last_name:"Fizika"});
  const group=ids.group,version=staffIds.draft,demo=ids.demo,issuer="https://synthetic.invalid/auth/v1",pair=await generateKeyPair("ES256");
  const jwk=await exportJWK(pair.publicKey);jwk.kid="first-test-synthetic";
  const actors={};
  const d=pool.read();
  for(const [role,session]of Object.entries({admin,teacher})){
    const person=session.profile.person_id,subject=crypto.randomUUID(),providerSession=crypto.randomUUID();
    d.people[person].roles=["student",role];d.people[person].profile.roles=["student",role];
    d.staffIdentities[issuer+"|"+subject]={person_id:person,revoked_at_ms:null};
    d.staffAccess[person]={approved:true,manage_content:role==="admin",manage_roster:role==="admin",all_groups:false,all_subjects:false};
    d.staffGroups[person]=[{group_id:group,revoked_at_ms:null}];d.staffSubjects[person]=[{subject_id:"physics",revoked_at_ms:null}];
    d.teacherSubjects[person]=role==="teacher"?[{subject_id:"physics",approved:true,revoked_at_ms:null}]:[];
    d.providerSessions[providerSession]=subject;
    const secs=Math.floor(pool.now/1000);
    actors[role]={person,subject,providerSession,token:await new SignJWT({iss:issuer,aud:"authenticated",role:"authenticated",sub:subject,session_id:providerSession,iat:secs-1,exp:secs+900})
      .setProtectedHeader({alg:"ES256",kid:jwk.kid}).sign(pair.privateKey)};
  }
  d.groups[group]={id:group,revision:0,status:"active"};
  d.demos[demo]={title:"Fizika — relational sintetik test",subjectId:"physics"};
  const wire={id:version,demo_id:demo,version_no:2,duration_seconds:600,instructions_blocks:[{type:"text",markdown:"Initial"}],status:"draft",revision:3,grading_config:{individual_enabled:false}};
  d.versions[version]={id:version,demo_id:demo,revision:3,status:"draft",wire,published_snapshot:null};
  durableWrite(path,d);
  ports={domain:"first_test_relational",jwt:{issuer,audience:"authenticated",algorithms:["ES256"],trustedKeys:createLocalJWKSet({keys:[jwk]}),now:()=>pool.now},
    liveness:async({transaction,sessionId,subject})=>(await transaction.client.query({name:"ua_contract_staff_session",text:"SELECT synthetic provider session",values:[sessionId,subject]})).rowCount===1,
    validate,newAssignmentId:()=>crypto.randomUUID()};
  const restart=async()=>{await local.close();const now=pool.now;pool=firstTestExecutor(path);pool.now=now;local=await startConfiguredServer({config:config(),allowedOrigins:[uiOrigin]});};
  await restart();
  const call=async(method,url,body,key="first-test-command",role="teacher")=>{
    const r=await fetch(local.baseUrl+url,{method,headers:{origin:uiOrigin,authorization:"Bearer "+actors[role].token,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});
    assert.equal(r.headers.get("access-control-allow-origin"),uiOrigin);const json=await r.json();
    assert.ok(validate(r.status<400?url.endsWith("/members")?"MembershipMutation":url==="/admin/assignments"?"Assignment":"Version":"Error",r.status<400?json.data:json),JSON.stringify(json));
    return {status:r.status,json};
  };
  const versionPath=`/admin/versions/${version}`,plan=contentPilotPlan();
  const publish=async()=>{
    for(const q of plan.questions)assert.equal((await call("PUT",`${versionPath}/questions/${q.id}`,q,`first-test-question:${q.id}`)).status,200);
    assert.equal((await call("PATCH",versionPath,plan.metadata,"first-test-duration")).status,200);
    const r=await call("POST",versionPath+"/publish",plan.publish,"first-test-publish");assert.equal(r.status,200,JSON.stringify(r));return r.json.data;
  };
  const memberBody={student_id:student.profile.person_id,status:"active",expected_revision:0,expected_membership_revision:0};
  const member=(key="first-test-member")=>call("PUT",`/admin/groups/${group}/members`,memberBody,key,"admin");
  const assignmentBody=published=>({group_id:group,demo_id:published.demo_id,version_id:published.id,student_ids:[student.profile.person_id],
    opens_at:new Date(clock-60000).toISOString(),closes_at:new Date((Math.floor((clock+18000000)/86400000)+1)*86400000-18000000).toISOString(),
    timezone:"Asia/Tashkent",review_policy:"teacher_approval",reminder_lead_seconds:null});
  const assign=(published,key="first-test-assignment")=>call("POST","/admin/assignments",assignmentBody(published),key,"admin");
  return {path,client,student,actors,group,version,demo,plan,versionPath,ports,config,call,publish,member,memberBody,assignmentBody,assign,restart,
    get pool(){return pool;},get local(){return local;},read:()=>pool.read(),raw:()=>readFileSync(path,"utf8"),update:fn=>{const d=pool.read();fn(d);durableWrite(path,d);}};
}
