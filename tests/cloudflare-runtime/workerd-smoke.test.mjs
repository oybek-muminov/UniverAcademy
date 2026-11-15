import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from '../../tooling/node_modules/miniflare/dist/src/index.js';
import {generateKeyPair,SignJWT} from 'jose';

// Run against a locally generated Wrangler --dry-run bundle. No real secrets,
// production database, provider requests or live Hyperdrive configuration are used here.
const bundlePath=process.env.UA_TEST_BUNDLE_PATH;
assert.ok(bundlePath,'Set UA_TEST_BUNDLE_PATH to the local dry-run cloudflare-worker.js');
const source=fs.readFileSync(bundlePath,'utf8');
const api='https://api.runtime.invalid',ui='https://mini.runtime.invalid',issuer='https://clerk.runtime.invalid';
const settings={issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},jwksCacheMs:60000,jwksCooldownMs:0,timeoutMs:3000,maxJwksBytes:65536};
const policy={initDataMaxAgeSeconds:300,futureSkewSeconds:0,accessTtlMs:900000,familyTtlMs:86400000,logoutTombstoneMs:86400000,identityCollisionAttempts:4,newLogin:'revoke_previous'};
function fixture(){
 const calls=[];
 const values={UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui]),UA_SESSION_POLICY:JSON.stringify(policy),UA_CLERK_PROVIDER_SETTINGS:JSON.stringify(settings),UA_CLERK_SECRET_KEY:'synthetic-only',HYPERDRIVE:{connectionString:'postgres://synthetic:synthetic@hyperdrive.invalid:5432/synthetic'}};
 const env=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{type:'json',value}]));
 const mf=new Miniflare({workers:[{config:{name:'api-runtime-smoke',compatibilityDate:'2026-11-11',compatibilityFlags:['nodejs_compat'],env,manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:source}}}},dev:{unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:request=>{calls.push({url:request.url,authorization:request.headers.has('authorization'),cookie:request.headers.has('cookie')});return new Response(null,{status:302,headers:{location:'https://must-not-follow.invalid'}});}}}}]});
 return {mf,calls};
}
test('workerd reaches missing-auth errors for GET and empty/nonempty POST without provider I/O',async()=>{
 const {mf,calls}=fixture();
 try{
  for(const [path,method,body,expected] of [['/api/v1/me','GET',undefined,'SESSION_REVOKED'],['/api/v1/auth/clerk','POST',undefined,'CLERK_TOKEN_INVALID'],['/api/v1/auth/clerk','POST','{}','CLERK_TOKEN_INVALID']]){
   const r=await mf.dispatchFetch(api+path,{method,headers:{origin:ui,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body})});
   assert.equal(r.status,401,method+' '+path);assert.equal((await r.json()).error.code,expected);
  }
  assert.equal(calls.length,0);
 }finally{await mf.dispose();}
});
test('workerd JWKS redirect fails closed with one request and no credential forwarding',async()=>{
 const {mf,calls}=fixture();
 try{
  const {privateKey}=await generateKeyPair('RS256');const now=Math.floor(Date.now()/1000);
  const token=await new SignJWT({iss:issuer,sub:'user_Synthetic',sid:'sess_Synthetic',iat:now-1,nbf:now-1,exp:now+60,azp:ui,jti:'synthetic',v:2}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).sign(privateKey);
  const r=await mf.dispatchFetch(api+'/api/v1/auth/clerk',{method:'POST',headers:{origin:ui,authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});
  assert.equal(r.status,503);assert.equal((await r.json()).error.code,'SERVICE_UNAVAILABLE');
  assert.deepEqual(calls,[{url:issuer+'/.well-known/jwks.json',authorization:false,cookie:false}]);
 }finally{await mf.dispose();}
});

// Real workerd Hyperdrive binding, but a synthetic loopback origin. The sentinel
// proves missing-auth requests never establish even a local database connection.
test('native workerd Hyperdrive query passes all startup guards without DB/provider I/O',async()=>{
 const {createServer}=await import('node:net');let connections=0;const calls=[];
 const server=createServer(socket=>{connections++;socket.destroy();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const opts=convertV4MiniflareOptions({modules:true,script:source,compatibilityDate:'2026-11-11',compatibilityFlags:['nodejs_compat'],
  bindings:{UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui]),UA_SESSION_POLICY:JSON.stringify(policy),UA_CLERK_PROVIDER_SETTINGS:JSON.stringify(settings),UA_CLERK_SECRET_KEY:'synthetic-only'},
  hyperdrives:{HYPERDRIVE:`postgres://synthetic:synthetic@127.0.0.1:${port}/synthetic`}});
 opts.workers[0].dev={...opts.workers[0].dev,unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:()=>{calls.push(1);return new Response(null,{status:503});}}};
 const mf=new Miniflare(opts);
 try{
  for(const [path,method,body,code] of [['/api/v1/me','GET',undefined,'SESSION_REVOKED'],['/api/v1/auth/clerk','POST','{}','CLERK_TOKEN_INVALID']]){
   const r=await mf.dispatchFetch(api+path,{method,headers:{origin:ui,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{})});
   assert.equal(r.status,401);assert.equal((await r.json()).error.code,code);
  }
  assert.equal(connections,0);assert.equal(calls.length,0);
 }finally{await mf.dispose();await new Promise(resolve=>server.close(resolve));}
});
