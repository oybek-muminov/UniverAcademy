import {test} from "node:test";
import assert from "node:assert/strict";
import {startConfiguredServer} from "../../runtime/configured-server.mjs";
import {withLocalCors} from "../../runtime/local-cors.mjs";
import {uiOrigin} from "./fixture.mjs";

test("local OPTIONS permits exact configured Mini App origin, methods and proof/idempotency headers without invoking storage/auth",async t=>{
  const local=await startConfiguredServer({config:{mode:"production"},allowedOrigins:[uiOrigin]});t.after(()=>local.close());
  for(const method of ["GET","POST","PUT","PATCH"]){
    const r=await fetch(local.baseUrl+"/exams",{method:"OPTIONS",headers:{Origin:uiOrigin,"Access-Control-Request-Method":method,"Access-Control-Request-Headers":"Authorization, Content-Type, Idempotency-Key"}});
    assert.equal(r.status,204);assert.equal(await r.text(),"");assert.equal(r.headers.get("access-control-allow-origin"),uiOrigin);
    assert.match(r.headers.get("access-control-allow-headers"),/authorization/);assert.match(r.headers.get("vary"),/Access-Control-Request-Headers/);
    assert.equal(r.headers.get("access-control-allow-credentials"),null);
  }
  const r=await fetch(local.baseUrl+"/exams",{headers:{origin:uiOrigin}});
  assert.equal(r.status,503);assert.equal(r.headers.get("access-control-allow-origin"),uiOrigin);
  assert.equal((await r.json()).error.code,"SERVICE_UNAVAILABLE"); // preflight never manufactures API readiness
});

test("unlisted/null/malformed origin, unknown method/header and missing preflight proof are denied before application writes",async()=>{
  let calls=0;const handler=withLocalCors(async()=>{calls++;return new Response("ok");},[uiOrigin]);
  for(const origin of ["null","https://foreign.example","http://127.0.0.1:5199",uiOrigin+"/",uiOrigin+", http://foreign.example"]){
    const r=await handler(new Request("http://127.0.0.1/api/v1/exams",{method:"POST",headers:{origin}}));
    assert.equal(r.status,403);assert.equal(r.headers.get("access-control-allow-origin"),null);
  }
  for(const headers of [{origin:uiOrigin},{origin:uiOrigin,"access-control-request-method":"DELETE"},
    {origin:uiOrigin,"access-control-request-method":"POST","access-control-request-headers":"X-Staff-Role"},
    {"access-control-request-method":"GET"}]){
    assert.equal((await handler(new Request("http://127.0.0.1/api/v1/exams",{method:"OPTIONS",headers}))).status,403);
  }
  assert.equal(calls,0);
});

test("local CORS preserves API error status/headers/body, exposes Retry-After, and has no wildcard/production origin default",async()=>{
  const handler=withLocalCors(async()=>new Response(JSON.stringify({error:{code:"SESSION_REVOKED"}}),{status:401,headers:{"retry-after":"3","vary":"Accept"}}),[uiOrigin]);
  const r=await handler(new Request("http://127.0.0.1/api/v1/me",{headers:{origin:uiOrigin}}));
  assert.equal(r.status,401);assert.equal((await r.json()).error.code,"SESSION_REVOKED");
  assert.equal(r.headers.get("retry-after"),"3");assert.equal(r.headers.get("access-control-expose-headers"),"Retry-After");
  assert.match(r.headers.get("vary"),/Accept, Origin/);
  for(const origin of ["*","null","https://api.example","http://127.0.0.1:5198/","http://user:pass@localhost:5198"])
    assert.throws(()=>withLocalCors(()=>{},[origin]));
  const defaultDeny=withLocalCors(()=>assert.fail("cross origin must not dispatch"));
  assert.equal((await defaultDeny(new Request("http://127.0.0.1/api/v1/me",{headers:{origin:uiOrigin}}))).status,403);
});
