import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createVercelNodeFunction,createVercelNodeEntrypoint,publicEnvironmentOptions} from "../../runtime/vercel-node.mjs";
import {createProductionStudentClient,STUDENT_CONTRACT_SHA256} from "../../packages/api-client/student-client.ts";
import {firstTestFixture} from "../first-test/fixture.mjs";
import {signedInitData,id} from "../backend/http-fixture.ts";

const apiOrigin="https://api.example.com",uiOrigin="https://student.example.com";
const options={apiOrigin,allowedOrigins:[uiOrigin]};
const request=(path="/api/v1/me",init={})=>new Request(apiOrigin+path,{...init,headers:{origin:uiOrigin,...init.headers}});
test("Vercel Node fetch transport requires explicit HTTPS origins and never defaults to fixture/pool configuration",async()=>{
  for(const origin of [undefined,"http://api.example.com","https://api.example.com/path","https://user:pass@api.example.com","https://*.vercel.app","https://localhost:443","https://127.0.0.1"])
    assert.throws(()=>createVercelNodeFunction({...options,apiOrigin:origin}),e=>e.status===503);
  for(const allowedOrigins of [undefined,"*",["*"],["null"],["http://student.example.com"],["https://*.vercel.app"]])
    assert.throws(()=>createVercelNodeFunction({...options,allowedOrigins}),e=>e.status===503);
  assert.throws(()=>createVercelNodeFunction({...options,configuration:{mode:"local_contract"}}),e=>e.status===503);
  const app=createVercelNodeFunction(options),r=await app.fetch(request());
  assert.equal(r.status,503);assert.equal((await r.json()).error.code,"SERVICE_UNAVAILABLE");
  for(const name of ["cache-control","cdn-cache-control","vercel-cdn-cache-control"])assert.equal(r.headers.get(name),"no-store");
  assert.equal(r.headers.get("access-control-allow-origin"),uiOrigin);
});

test("public HTTPS OPTIONS works without DB/auth but exact origins, methods, headers and /api/v1 boundary remain mandatory",async()=>{
  const app=createVercelNodeFunction(options);
  for(const method of ["GET","POST","PUT","PATCH"]){
    const r=await app.fetch(request("/api/v1/exams",{method:"OPTIONS",headers:{"access-control-request-method":method,"access-control-request-headers":"Authorization, Content-Type, Idempotency-Key"}}));
    assert.equal(r.status,204);assert.equal(await r.text(),"");assert.equal(r.headers.get("access-control-allow-origin"),uiOrigin);
    assert.equal(r.headers.get("access-control-allow-credentials"),null);assert.equal(r.headers.get("access-control-expose-headers"),"Retry-After");
    assert.match(r.headers.get("vary"),/Access-Control-Request-Headers/);
  }
  for(const origin of ["null","https://foreign.example.com",uiOrigin+"/","https://api.example.com"]){
    const r=await app.fetch(request("/api/v1/exams",{headers:{origin}}));assert.equal(r.status,403);assert.equal(r.headers.get("access-control-allow-origin"),null);
  }
  assert.equal((await app.fetch(request("/api/v1/exams",{method:"OPTIONS",headers:{"access-control-request-method":"DELETE"}}))).status,403);
  assert.equal((await app.fetch(request("/api/v1/exams",{method:"OPTIONS",headers:{"access-control-request-method":"GET","access-control-request-headers":"X-Staff-Role"}}))).status,403);
  for(const path of ["/api/index","/api/v10/exams","/api/v1","/admin/assignments"])
    assert.equal((await app.fetch(request(path))).status,404);
  const forwarded=await app.fetch(new Request("https://foreign.example.com/api/v1/me",{headers:{origin:uiOrigin,"x-forwarded-host":"api.example.com","x-forwarded-proto":"https"}}));
  assert.equal(forwarded.status,400); // Never reconstruct authority/route from caller headers.
  const insecure=await app.fetch(new Request("http://api.example.com/api/v1/exams",{method:"OPTIONS",headers:{origin:uiOrigin,"access-control-request-method":"GET","x-forwarded-proto":"https"}}));
  assert.equal(insecure.status,400);
});

test("raw body boundary limits chunks and length without parsing/reserializing JSON or leaking input",async()=>{
  const app=createVercelNodeFunction(options);
  const length=await app.fetch(request("/api/v1/auth/telegram",{method:"POST",headers:{"content-length":"65537"},body:"x"}));assert.equal(length.status,400);
  const mismatch=await app.fetch(request("/api/v1/auth/telegram",{method:"POST",headers:{"content-length":"2"},body:"x"}));assert.equal(mismatch.status,400);
  for(const size of [65536,65537]){
    const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(32768));c.enqueue(new Uint8Array(size-32768));c.close();}});
    const r=await app.fetch(request("/api/v1/auth/telegram",{method:"POST",body:stream,duplex:"half"}));
    assert.equal(r.status,size===65536?503:400);
  }
  const broken=new ReadableStream({start(c){c.error(Error("never-echo-body-secret"));}});
  const r=await app.fetch(request("/api/v1/auth/telegram",{method:"POST",body:broken,duplex:"half"}));
  assert.equal(r.status,400);assert.ok(!(await r.text()).includes("never-echo-body-secret"));
});

test("warm entry caches only its configured handler and sanitizes bad/missing environment/bootstrap failures",async()=>{
  let reads=0;const app=createVercelNodeEntrypoint(()=>{reads++;return options;});
  await app.fetch(request());await app.fetch(request());assert.equal(reads,1);
  const missing=createVercelNodeEntrypoint(()=>publicEnvironmentOptions({}));
  const r=await missing.fetch(request());assert.equal(r.status,503);assert.equal((await r.json()).error.code,"SERVICE_UNAVAILABLE");
  const bad=createVercelNodeEntrypoint(()=>{throw Error("never-echo-bootstrap-secret");});
  const fault=await bad.fetch(request());assert.equal(fault.status,500);assert.ok(!(await fault.text()).includes("never-echo-bootstrap-secret"));
  assert.deepEqual(publicEnvironmentOptions({UA_API_ORIGIN:apiOrigin,UA_ALLOWED_ORIGINS:JSON.stringify([uiOrigin])}),options);
  for(const value of ["not-json","null",'"*"','["https://*.vercel.app"]'])
    assert.throws(()=>publicEnvironmentOptions({UA_API_ORIGIN:apiOrigin,UA_ALLOWED_ORIGINS:value}),e=>e.status===503);
});

test("default api module is the Web fetch export and fails503 until real server bindings are supplied; routing proposal has no SPA/API wildcard takeover",async t=>{
  const before=[process.env.UA_API_ORIGIN,process.env.UA_ALLOWED_ORIGINS];
  t.after(()=>{for(const [i,key]of ["UA_API_ORIGIN","UA_ALLOWED_ORIGINS"].entries()){if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];}});
  process.env.UA_API_ORIGIN=apiOrigin;process.env.UA_ALLOWED_ORIGINS=JSON.stringify([uiOrigin]);
  const entry=(await import("../../api/index.mjs")).default;assert.equal(typeof entry.fetch,"function");
  assert.equal((await entry.fetch(request())).status,503);
  const routing=JSON.parse(readFileSync(new URL("../../vercel.json",import.meta.url)));
  assert.equal(routing.framework,null);assert.deepEqual(routing.rewrites,[{source:"/api/v1/:path*",destination:"/api/index"}]);
});

test("existing production handler over Vercel fetch keeps Teacher/Admin/student flow, raw Unicode, CAS, deadline, wire and one-device behavior",async t=>{
  const f=await firstTestFixture(t);
  // Injected synthetic SQL executor implements the PgPool port only for this test.
  // The production kind label here is not evidence of a real PostgreSQL driver/DB.
  const configuration={...f.config(),mode:"production",storage:{kind:"postgres",pool:f.pool}};
  let app=createVercelNodeFunction({...options,configuration});
  const transport=req=>app.fetch(new Request(req,{headers:new Headers([...req.headers,["origin",uiOrigin]])}));
  const client=createProductionStudentClient({mode:"production",baseUrl:apiOrigin+"/api/v1",contractSha256:STUDENT_CONTRACT_SHA256,transport});
  const session=(await client.telegramLogin({init_data:signedInitData(4000000401,crypto.randomUUID(),f.pool.now)})).data;
  const token=session.access_token,person=session.profile.person_id;
  // Split inside a multibyte UTF-8 character; existing profile parser sees exact original bytes.
  const encoded=new TextEncoder().encode(JSON.stringify({first_name:"O‘quvchi",last_name:"Sintetik"}));
  const split=encoded.indexOf(0xe2)+1;
  const body=new ReadableStream({start(c){c.enqueue(encoded.slice(0,split));c.enqueue(encoded.slice(split));c.close();}});
  const profile=await app.fetch(request("/api/v1/me",{method:"PATCH",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body,duplex:"half"}));
  assert.equal(profile.status,200);assert.equal((await profile.json()).data.first_name,"O‘quvchi");
  assert.deepEqual((await client.exams(token)).data,[]);
  const call=async(method,path,payload,key,role="teacher")=>{
    const r=await app.fetch(request("/api/v1"+path,{method,headers:{authorization:"Bearer "+f.actors[role].token,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(payload)}));
    return{status:r.status,json:await r.json()};
  };
  for(const q of f.plan.questions)assert.equal((await call("PUT",`${f.versionPath}/questions/${q.id}`,q,"vercel-question:"+q.id)).status,200);
  assert.equal((await call("PATCH",f.versionPath,f.plan.metadata,"vercel-duration")).status,200);
  const published=await call("POST",f.versionPath+"/publish",f.plan.publish,"vercel-publish");assert.equal(published.status,200);
  assert.equal((await call("PUT",`/admin/groups/${f.group}/members`,{...f.memberBody,student_id:person},"vercel-member","admin")).status,200);
  const assigned=await call("POST","/admin/assignments",{...f.assignmentBody(published.json.data),student_ids:[person]},"vercel-assignment","admin");assert.equal(assigned.status,201);
  const assignment=assigned.json.data.id,attempt=(await client.startAttempt(token,assignment,{confirmed:true},"vercel-start")).data;
  assert.equal(Date.parse(attempt.deadline_at)-Date.parse(attempt.started_at),420000);
  const question=attempt.questions.find(q=>q.id===id(300)),correct=question.options.find(o=>o.blocks[0].markdown==="Yangi A");
  assert.equal((await client.saveAnswer(token,attempt.id,question.id,{selected_option_id:correct.id,expected_revision:0})).data.revision,1);
  await assert.rejects(client.saveAnswer(token,attempt.id,question.id,{selected_option_id:null,expected_revision:0}),e=>e.status===409);
  app=createVercelNodeFunction({...options,configuration}); // New warm function, same durable test rows.
  const next=(await client.telegramLogin({init_data:signedInitData(4000000401,crypto.randomUUID(),f.pool.now)})).data;
  await assert.rejects(client.me(token),e=>e.status===401);
  const resume=(await client.resumeAttempt(next.access_token,attempt.id)).data;assert.equal(resume.deadline_at,attempt.deadline_at);assert.equal(resume.answers[0].revision,1);
  const result=(await client.submitAttempt(next.access_token,attempt.id,"vercel-submit")).data;
  assert.deepEqual(result.ordinary.display,{earned_points:"0.1",max_points:"0.3",percentage:"50.00"});assert.equal(result.statistical_bonus,null);
  assert.deepEqual((await client.history(next.access_token,assignment)).data.attempts[0].score,result);
  const wire=JSON.stringify({attempt,resume,result});for(const key of ["correct_option_id","correctOptionId","numerator","denominator","publishedSnapshot"])assert.ok(!wire.includes(key));
  assert.ok(!f.raw().includes(next.access_token));
  f.pool.failStatement="ua_http_person";
  await assert.rejects(client.me(next.access_token),e=>e.status===500&&e.code==="INTERNAL_ERROR");
});
