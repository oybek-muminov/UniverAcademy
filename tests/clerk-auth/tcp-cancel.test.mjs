import {test} from "node:test";
import assert from "node:assert/strict";
import {connect} from "node:net";
import {once,getEventListeners} from "node:events";
const {startLocalServer}=await import(process.env.UA_TCP_SERVER_MODULE??"../../runtime/local-server.mjs");
import {createClerkSdkBindings} from "../../runtime/clerk-sdk-bindings.mjs";
import {createClerkProviderAdapter} from "../../supabase/functions/univeracademy-api/clerk-provider.ts";
import {clerkFixture,users,sids,issuer} from "./fixture.mjs";

async function client(server,body="{}"){
  const socket=connect(server.server.address().port,"127.0.0.1");socket.on("error",()=>{});await once(socket,"connect");
  socket.write(`POST /api/v1/auth/clerk HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  return socket;
}
test("TCP-CANCEL-1: completed POST body then TCP disconnect aborts Request and active SDK before500ms provider fallback",{timeout:10000},async t=>{
  const entered=Promise.withResolvers(),aborted=Promise.withResolvers(),handled=Promise.withResolvers(),late=Promise.withResolvers();let request,commits=0;
  const sdk=await createClerkSdkBindings({secretKey:"synthetic-server-secret",now:()=>Date.UTC(2026,10,7),timeoutMs:3000,maxResponseBytes:65536,
    transport:provider=>{provider.signal.addEventListener("abort",()=>aborted.resolve(provider),{once:true});entered.resolve();return late.promise;}});
  t.after(()=>sdk.close());
  const server=await startLocalServer({lab:{handler:async r=>{
    request=r;try{await sdk.getSession("sess_TcpSyntheticA1",{signal:AbortSignal.any([r.signal,AbortSignal.timeout(500)])});if(!r.signal.aborted)commits++;return new Response("{}");}
    catch{return new Response("{}",{status:503});}finally{handled.resolve();}
  }}});t.after(()=>server.close());
  const socket=await client(server);await entered.promise;socket.destroy();const provider=await aborted.promise;
  assert.equal(request.signal.aborted,true,"disconnect must reach Request.signal, not only the provider timer");
  assert.equal(provider.signal.aborted,true);await handled.promise;assert.equal(commits,0);
  let disposed=false;late.resolve(new Response(new ReadableStream({cancel(){disposed=true;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(disposed,true);
});

test("normal POST body completion and response finish do not cancel the Request; adapter listeners are removed",{timeout:10000},async t=>{
  let signal,pair;const server=await startLocalServer({lab:{handler:async request=>{signal=request.signal;await new Promise(resolve=>setImmediate(resolve));assert.equal(signal.aborted,false);return new Response("{}");}}});
  server.server.on("request",(input,output)=>{pair={input,output};});t.after(()=>server.close());
  const r=await fetch(server.baseUrl+"/auth/clerk",{method:"POST",body:"{}"});assert.equal(r.status,200);await r.text();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(signal.aborted,false);assert.equal(getEventListeners(pair.input,"aborted").filter(f=>f.name==="abort").length,0);
  assert.equal(getEventListeners(pair.output,"close").filter(f=>f.name==="closed").length,0);assert.equal(getEventListeners(pair.output,"finish").filter(f=>f.name==="cleanup").length,0);
});

test("disconnect after a durable commit does not undo it or claim a delivered ACK",{timeout:10000},async t=>{
  const committed=Promise.withResolvers(),finish=Promise.withResolvers(),cancelled=Promise.withResolvers(),done=Promise.withResolvers();let commits=0;
  const server=await startLocalServer({lab:{handler:async request=>{
    request.signal.addEventListener("abort",()=>cancelled.resolve(),{once:true});commits++;committed.resolve();await finish.promise;
    done.resolve();return new Response('{"data":{"committed":true}}');
  }}});t.after(()=>server.close());
  const socket=await client(server);await committed.promise;socket.destroy();await cancelled.promise;assert.equal(commits,1);
  finish.resolve();await done.promise;assert.equal(commits,1); // ACK cannot be delivered to the destroyed connection.
});

test("real Clerk HTTP guard relays a TCP disconnect through500ms liveness to SDK transport without auth writes",{timeout:10000},async t=>{
  const f=await clerkFixture({fresh:true}),entered=Promise.withResolvers(),aborted=Promise.withResolvers(),handled=Promise.withResolvers(),late=Promise.withResolvers();let incoming;
  const sdk=await createClerkSdkBindings({secretKey:"synthetic-server-secret",now:()=>f.store.time,timeoutMs:3000,maxResponseBytes:65536,transport:request=>{entered.resolve(request);request.signal.addEventListener("abort",()=>aborted.resolve(),{once:true});return late.promise;}});t.after(()=>sdk.close());
  const adapter=createClerkProviderAdapter({issuer,authorizedParties:["https://student.example.com"],audience:{kind:"clerk_default_no_audience"},jwksCacheMs:300000,jwksCooldownMs:30000,timeoutMs:500,maxJwksBytes:65536},sdk);
  f.deps.liveness=adapter.liveness;f.resetHandler();const before=f.snapshot();
  const server=await startLocalServer({lab:{handler:async request=>{incoming=request;try{return await f.handler(request);}finally{handled.resolve();}}}});t.after(()=>server.close());
  const token=await f.sign({userId:users.student,sessionId:sids.first}),socket=connect(server.server.address().port,"127.0.0.1");socket.on("error",()=>{});await once(socket,"connect");
  socket.write(`POST /api/v1/auth/clerk HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
  const request=await entered.promise;socket.destroy();await aborted.promise;assert.equal(incoming.signal.aborted,true);assert.equal(request.signal.aborted,true);await handled.promise;
  assert.deepEqual(f.store.state,before);late.resolve(new Response("{}",{headers:{"content-type":"application/json"}}));
});

test("disconnect during an incomplete body never dispatches the handler",{timeout:10000},async t=>{
  let calls=0;const closed=Promise.withResolvers(),server=await startLocalServer({lab:{handler:async()=>{calls++;return new Response("{}");}}});t.after(()=>server.close());
  server.server.on("request",input=>input.once("aborted",()=>closed.resolve()));
  const socket=connect(server.server.address().port,"127.0.0.1");socket.on("error",()=>{});await once(socket,"connect");
  socket.write("POST /api/v1/auth/clerk HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{");
  await new Promise(resolve=>setTimeout(resolve,20));socket.destroy();await closed.promise;assert.equal(calls,0);
});
