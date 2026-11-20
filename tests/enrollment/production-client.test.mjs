import {test} from "node:test";
import assert from "node:assert/strict";
import {createProductionStudentClient,createLocalStudentClient,StudentApiError,StudentClientProtocolError,STUDENT_CONTRACT_SHA256} from "../../packages/api-client/student-client.ts";
const options=(transport)=>({mode:"production",contractSha256:STUDENT_CONTRACT_SHA256,baseUrl:"https://api.univeracademy.uz/api/v1",transport});
const success=(data)=>new Response(JSON.stringify({data}),{status:200,headers:{"content-type":"application/json"}});
const profile={person_id:"00000000-0000-4000-8000-000000000001",first_name:"Dilnoza",last_name:"Saidova",
  roles:["student"],registration_complete:true,active_group_id:null,univeracademy_id:"0100000001"};
const session={access_token:"opaque-access",refresh_token:"opaque-refresh",token_type:"Bearer",expires_at:"2030-01-01T00:00:00Z",
  refresh_expires_at:"2030-01-02T00:00:00Z",profile};
test("production constructor requires explicit pinned HTTPS endpoint/transport and rejects local fixture destinations before I/O",()=>{
  let requests=0;const transport=async()=>{requests++;return success({});};
  for(const baseUrl of ["http://api.univeracademy.uz/api/v1","https://localhost/api/v1","https://127.0.0.2/api/v1","https://[::1]/api/v1","https://local.invalid/api/v1","https://api.univeracademy.uz/api/v1?x=1","https://user:password@api.univeracademy.uz/api/v1","https://api.univeracademy.uz/other"])
    assert.throws(()=>createProductionStudentClient({...options(transport),baseUrl}),e=>e instanceof StudentClientProtocolError&&e.message==="INVALID_PRODUCTION_BASE_URL");
  assert.throws(()=>createProductionStudentClient({...options(transport),mode:"local_fixture"}),/PRODUCTION_CLIENT_MODE_REQUIRED/);
  assert.throws(()=>createProductionStudentClient({...options(transport),contractSha256:"wrong"}),/CONTRACT_HASH_MISMATCH/);
  assert.throws(()=>createProductionStudentClient({...options(transport),transport:undefined}),/INVALID_PRODUCTION_BASE_URL/);
  assert.equal(requests,0);
});
test("production and local constructors share the same operation surface; production requests suppress cookies, redirects and cache",async()=>{
  const requests=[],client=createProductionStudentClient(options(async request=>{requests.push(request);const path=new URL(request.url).pathname;
    return success(path.endsWith("/me")?profile:path.endsWith("/telegram")?session:{ok:true});}));
  const local=createLocalStudentClient({mode:"local_fixture",contractSha256:STUDENT_CONTRACT_SHA256,baseUrl:"http://127.0.0.1:8793/api/v1",transport:async()=>success({})});
  assert.deepEqual(Object.keys(client),Object.keys(local));
  await client.telegramLogin({init_data:"synthetic-init-data"});await client.me("synthetic-access");
  await client.logoutByRefresh({refresh_token:"synthetic-refresh"});
  for(const r of requests){assert.equal(r.redirect,"error");assert.equal(r.credentials,"omit");assert.equal(r.cache,"no-store");assert.equal(r.headers.get("accept"),"application/json; profile=univeracademy-id-v2");}
  assert.equal(requests[0].url,"https://api.univeracademy.uz/api/v1/auth/telegram");assert.equal(requests[0].headers.get("authorization"),null);
  assert.equal(requests[1].headers.get("authorization"),"Bearer synthetic-access");
  assert.equal(requests[2].headers.get("authorization"),null);assert.deepEqual(await requests[2].json(),{refresh_token:"synthetic-refresh"});
});
test("ordinary profile and session retain supported UUID variants, names and UTC fractional precision",async()=>{
  const value={...profile,person_id:"01929712-a5ac-7c00-8001-214e2caf0023",active_group_id:"00000000-0000-0000-0000-000000000000",first_name:"A".repeat(101)};
  const auth={...session,expires_at:"2030-01-01T00:00:00.123456Z",profile:value};
  const client=createProductionStudentClient(options(async request=>success(new URL(request.url).pathname.endsWith("/me")?value:auth)));
  assert.deepEqual((await client.me("opaque")).data,value);
  assert.deepEqual((await client.exchangeClerkSession("clerk")).data,auth);
});
test("production constructor preserves wire paths, save CAS and explicit submit/start idempotency keys",async()=>{
  const seen=[],client=createProductionStudentClient(options(async request=>{seen.push(request);return success({});}));
  await client.startAttempt("access","assignment",{confirmed:true},"start-once");
  await client.saveAnswer("access","attempt","question",{selected_option_id:null,expected_revision:7});
  await client.submitAttempt("access","attempt","submit-once");
  assert.equal(seen[0].headers.get("idempotency-key"),"start-once");assert.equal(seen[0].url.endsWith("/exams/assignment/attempts"),true);
  assert.equal(seen[1].method,"PUT");assert.deepEqual(await seen[1].json(),{selected_option_id:null,expected_revision:7});
  assert.equal(seen[2].headers.get("idempotency-key"),"submit-once");assert.equal(await seen[2].text(),"");
});
test("production constructor keeps refresh coalescing and never retries a consumed/uncertain proof or failed command",async()=>{
  let count=0,finish;const wait=new Promise(resolve=>{finish=resolve;});
  const client=createProductionStudentClient(options(async()=>{count++;await wait;return success(session);}));
  const a=client.refresh({refresh_token:"synthetic-refresh"}),b=client.refresh({refresh_token:"synthetic-refresh"});assert.equal(a,b);finish();await a;assert.equal(count,1);
  await assert.rejects(client.refresh({refresh_token:"synthetic-refresh"}),/REFRESH_PROOF_ALREADY_ATTEMPTED/);assert.equal(count,1);
  let failures=0;const bad=createProductionStudentClient(options(async()=>{failures++;return new Response(JSON.stringify({error:{code:"SERVICE_UNAVAILABLE",message:"do-not-echo-raw-secret",request_id:"00000000-0000-4000-8000-000000000001"}}),{status:503});}));
  await assert.rejects(bad.submitAttempt("access","attempt","submit-once"),e=>e instanceof StudentApiError&&e.status===503&&e.message==="SERVICE_UNAVAILABLE");assert.equal(failures,1);
});
